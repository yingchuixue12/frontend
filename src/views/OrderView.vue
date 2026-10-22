<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { ElMessage } from 'element-plus'
import { Download } from '@element-plus/icons-vue'
import MainLayout from '../layouts/MainLayout.vue'
import {
  ORDER_STATUS_META,
  TASK_STATUS_META,
  getAdminOrderDetail,
  getAdminOrders,
  getAdminTaskDetail,
  getAdminTasks,
} from '../api/modules/admin-query'
import {
  buildTaskIndex,
  classifyAdminKeyword,
  fetchPendingComplaints,
  scanInProgressTasks,
  scanOrders,
} from '../api/modules/admin-scan'
import type { AdminOrderVo, AdminTaskVo } from '../types/admin'
import { formatClock, formatDateTime } from '../utils/date'
import { toCsv } from '../utils/csv'

/* ------------------------------------------------------------------
 * 订单列表（REQ-FRONTEND-001 §2.1）
 *
 * URL query（status/date/dispute/q/page/size）是筛选的唯一事实源：
 * 首页指标卡与待办跳 /orders?status=in_progress、?date=today、?dispute=pending，
 * 控件改动经 router.replace 回写 URL，再由 watch 统一解析并加载。
 *
 * 取数分两种：
 *  - 基础模式（无日期/关键字/争议/执行中筛选）：服务端分页 /admin/orders；
 *  - 客户端模式：后端不支持日期/关键字/争议过滤 → admin-scan 扫描候选集后本地筛选分页。
 * 例外：订单号 MO…/任务号 RT… 是后端的精确过滤条件，识别为编号时下推到服务端，
 * 不再受客户端扫描上限（1000 条）影响；其余文本关键字仍走本地模糊匹配。
 * 执行中（in_progress）筛选直接以 /admin/tasks?status=IN_PROGRESS 为行源（任务 VO 已含
 * 订单号/金额/双状态/飞手），顺带满足「飞行中置顶」。
 * ------------------------------------------------------------------ */
const route = useRoute()
const router = useRouter()

const ORDER_STATUS_ENUMS = [
  'PENDING',
  'PAID',
  'CANCELLED',
  'REFUNDED',
  'COMPLETED',
  'WAITING_CONFIRM',
  'DISPUTED',
]
const PAGE_SIZES = [10, 20, 50, 100]

interface OrderRow {
  orderNum?: string
  taskNum?: string
  taskName?: string
  ownerName?: string
  riderName?: string
  totalAmount?: number
  totalDistance?: number
  orderStatusCode?: number
  orderStatusDesc?: string
  createTime?: string
  updateTime?: string
  flying: boolean
}

/** 解析 URL query → 筛选状态（非法值一律回落为空，避免把脏参数打到后端） */
const parseQuery = (query: Record<string, unknown>) => {
  const rawStatus = String(query.status ?? '').trim()
  let status = ''
  if (rawStatus) {
    const upper = rawStatus.toUpperCase()
    if (upper === 'IN_PROGRESS') {
      status = 'in_progress'
    } else if (ORDER_STATUS_ENUMS.includes(upper)) {
      status = upper
    } else {
      const code = Number(rawStatus)
      if (Number.isInteger(code) && ORDER_STATUS_META[code]) {
        status = String(code)
      }
    }
  }

  const rawDate = String(query.date ?? '')
  const rawDispute = String(query.dispute ?? '')
  const size = Number(query.size)
  return {
    status,
    date: rawDate === 'today' || rawDate === '7d' ? rawDate : '',
    dispute: rawDispute === 'pending' ? 'pending' : '',
    q: String(query.q ?? ''),
    page: (Number.isSafeInteger(Number(query.page)) && Number(query.page) > 0 ? Number(query.page) : 1),
    size: PAGE_SIZES.includes(size) ? size : 10,
  }
}

const filters = reactive({ status: '', date: '', dispute: '', q: '' })
const pageNo = ref(1)
const pageSize = ref(10)

const rows = ref<OrderRow[]>([])
const total = ref(0)
const loading = ref(false)
const truncated = ref(false)
const updatedAt = ref('--:--:--')

/** URL 关键字 → 服务端精确过滤参数（编号）或本地模糊匹配（文本） */
const keywordQuery = computed(() => classifyAdminKeyword(filters.q))
const textKeyword = computed(() => (keywordQuery.value.kind === 'text' ? keywordQuery.value.value : ''))
/** 服务端可精确过滤的编号参数；文本关键字为空 */
const numberParams = computed<{ orderNum?: string; taskNum?: string }>(() => {
  const { kind, value } = keywordQuery.value
  if (!value) return {}
  if (kind === 'orderNum') return { orderNum: value }
  if (kind === 'taskNum') return { taskNum: value }
  return {}
})

const clientMode = computed(
  () =>
    filters.status === 'in_progress' ||
    Boolean(filters.date || filters.dispute || textKeyword.value),
)

/** 客户端模式持有筛选后全量，页码切片在此完成；基础模式 rows 已是当前页 */
const pagedRows = computed(() =>
  clientMode.value
    ? rows.value.slice((pageNo.value - 1) * pageSize.value, pageNo.value * pageSize.value)
    : rows.value,
)

const statusOptions = [
  { value: 'in_progress', label: '飞行中' },
  ...Object.entries(ORDER_STATUS_META).map(([code, meta]) => ({ value: code, label: meta.label })),
]
const dateOptions = [
  { value: 'today', label: '今天' },
  { value: '7d', label: '近 7 天' },
]
const disputeOptions = [{ value: 'pending', label: '待处理争议' }]

/** 时间筛选 → 服务端扫描下界（createTime 字符串比较，格式同为 yyyy-MM-dd HH:mm:ss） */
const dateCutoff = () => {
  if (filters.date === 'today') {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    return formatDateTime(midnight)
  }
  if (filters.date === '7d') {
    return formatDateTime(new Date(Date.now() - 7 * 86_400_000))
  }
  return undefined
}

const matchesKeyword = (row: OrderRow, keyword: string) =>
  [row.orderNum, row.taskNum, row.taskName, row.ownerName, row.riderName]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(keyword))

/** 飞行中置顶，其次按更新时间倒序（未填更新时间视为最早） */
const compareRows = (left: OrderRow, right: OrderRow) => {
  if (left.flying !== right.flying) {
    return left.flying ? -1 : 1
  }
  return (right.updateTime ?? '').localeCompare(left.updateTime ?? '')
}

const fromOrderVo = (
  vo: AdminOrderVo,
  riderByTask: Map<string, AdminTaskVo>,
  flyingOrders: Set<string>,
): OrderRow => ({
  orderNum: vo.orderNum,
  taskNum: vo.taskNum,
  taskName: vo.taskName,
  ownerName: vo.ownerName,
  riderName: vo.taskNum ? riderByTask.get(vo.taskNum)?.riderName : undefined,
  totalAmount: vo.totalAmount,
  totalDistance: vo.totalDistance,
  orderStatusCode: vo.orderStatusCode,
  orderStatusDesc: vo.orderStatusDesc,
  createTime: vo.createTime,
  updateTime: vo.updateTime,
  flying: Boolean(vo.orderNum && flyingOrders.has(vo.orderNum)),
})

const fromTaskVo = (task: AdminTaskVo): OrderRow => ({
  orderNum: task.orderNum,
  taskNum: task.taskNum,
  taskName: task.taskName,
  ownerName: task.ownerName,
  riderName: task.riderName,
  totalAmount: task.totalAmount,
  totalDistance: task.totalDistance,
  orderStatusCode: task.orderStatusCode,
  orderStatusDesc: task.orderStatusDesc,
  createTime: task.createTime,
  updateTime: task.updateTime,
  flying: task.taskStatus === 'IN_PROGRESS',
})

let loadSeq = 0
const load = async () => {
  const seq = ++loadSeq
  loading.value = true
  try {
    const cutoff = dateCutoff()
    const numbers = numberParams.value
    const keyword = textKeyword.value
    const complaints = filters.dispute === 'pending' ? await fetchPendingComplaints() : undefined
    const disputeOrders = complaints ? new Set(complaints.rows.map((item) => item.orderNum)) : undefined

    if (filters.status === 'in_progress') {
      // 任务号可直接下推；订单号不是 /admin/tasks 的过滤条件 → 先由订单详情解析出任务号，
      // 避免为了一个订单去扫描 1000 条执行中任务。
      let taskNum = numbers.taskNum
      if (!taskNum && numbers.orderNum) {
        const detail = await getAdminOrderDetail(numbers.orderNum).catch(() => undefined)
        if (seq !== loadSeq) return
        taskNum = detail?.taskNum || undefined
        if (!taskNum) {
          rows.value = []
          total.value = 0
          truncated.value = false
          updatedAt.value = formatClock()
          return
        }
      }
      const taskScan = await scanInProgressTasks({ taskNum })
      const tasks = taskScan.rows.filter((task) => task.taskStatus === 'IN_PROGRESS')
      let list = tasks.map(fromTaskVo)
      if (cutoff) {
        list = list.filter((row) => !row.createTime || row.createTime >= cutoff)
      }
      if (disputeOrders) {
        list = list.filter((row) => row.orderNum && disputeOrders.has(row.orderNum))
      }
      if (keyword) {
        list = list.filter((row) => matchesKeyword(row, keyword))
      }
      if (seq !== loadSeq) return
      list.sort(compareRows)
      rows.value = list
      total.value = list.length
      truncated.value = taskScan.truncated || Boolean(complaints?.truncated)
    } else if (clientMode.value) {
      const [riderByTask, flying, scan] = await Promise.all([
        buildTaskIndex(),
        scanInProgressTasks(),
        scanOrders({
          status: filters.status || undefined,
          cutoff,
          orderNum: numbers.orderNum,
          taskNum: numbers.taskNum,
        }),
      ])
      const flyingOrders = new Set(
        flying.rows
          .filter((task) => task.taskStatus === 'IN_PROGRESS')
          .map((task) => task.orderNum)
          .filter((orderNum): orderNum is string => Boolean(orderNum)),
      )
      let list = scan.rows.map((vo) => fromOrderVo(vo, riderByTask.index, flyingOrders))
      if (disputeOrders) {
        list = list.filter((row) => row.orderNum && disputeOrders.has(row.orderNum))
      }
      if (keyword) {
        list = list.filter((row) => matchesKeyword(row, keyword))
      }
      if (seq !== loadSeq) return
      list.sort(compareRows)
      rows.value = list
      total.value = list.length
      truncated.value = scan.truncated || riderByTask.truncated || flying.truncated || Boolean(complaints?.truncated)
    } else {
      const [riderByTask, flying, page] = await Promise.all([
        buildTaskIndex(),
        scanInProgressTasks({ taskNum: numbers.taskNum }),
        getAdminOrders({
          page: pageNo.value - 1,
          size: pageSize.value,
          status: filters.status || undefined,
          orderNum: numbers.orderNum,
          taskNum: numbers.taskNum,
        }),
      ])
      if (seq !== loadSeq) return
      const flyingOrders = new Set(
        flying.rows
          .filter((task) => task.taskStatus === 'IN_PROGRESS')
          .map((task) => task.orderNum)
          .filter((orderNum): orderNum is string => Boolean(orderNum)),
      )
      const pageRows = (page.content ?? []).map((vo) => fromOrderVo(vo, riderByTask.index, flyingOrders))
      total.value = page.totalElements ?? pageRows.length
      truncated.value = riderByTask.truncated || flying.truncated
      const list = pageRows
      list.sort(compareRows)
      rows.value = list
    }
    updatedAt.value = formatClock()
  } catch (err) {
    if (seq === loadSeq) {
      ElMessage.error(err instanceof Error ? err.message : '加载订单失败')
    }
  } finally {
    if (seq === loadSeq) {
      loading.value = false
    }
  }
}

/** 把本地筛选回写 URL（page 默认 1、size 默认 10 不入参），导航后由 watch 触发加载 */
const applyQuery = (patch: { page?: number; size?: number } = {}) => {
  const page = patch.page ?? 1
  const size = patch.size ?? pageSize.value
  if (patch.size !== undefined) {
    pageSize.value = patch.size
  }

  const query: Record<string, string> = {}
  if (filters.status) query.status = filters.status
  if (filters.date) query.date = filters.date
  if (filters.dispute) query.dispute = filters.dispute
  if (filters.q.trim()) query.q = filters.q.trim()
  if (page > 1) query.page = String(page)
  if (size !== 10) query.size = String(size)

  void router.replace({ name: 'orders', query })
}

const resetFilters = () => {
  filters.status = ''
  filters.date = ''
  filters.dispute = ''
  filters.q = ''
  applyQuery()
}

// 首次同步必须加载（组件挂载即取数）；此后 route.query 的变化只可能来自导航：
// 留在 /orders 内 = 筛选变化 → 加载；离开 /orders = 组件即将卸载 → 不再回拉。
let firstQuerySync = true
watch(
  () => route.query,
  (query) => {
    const parsed = parseQuery(query)
    filters.status = parsed.status
    filters.date = parsed.date
    filters.dispute = parsed.dispute
    filters.q = parsed.q
    pageNo.value = parsed.page
    pageSize.value = parsed.size
    if (firstQuerySync || route.name === 'orders') {
      firstQuerySync = false
      void load()
    }
  },
  { immediate: true },
)

const rowClassName = ({ row }: { row: OrderRow }) => (row.flying ? 'flying-row' : '')

// ==================== 订单详情抽屉（行内「详情」速览） ====================
const orderDetailVisible = ref(false)
const orderDetailLoading = ref(false)
const orderDetail = ref<AdminOrderVo>()

let orderDetailSeq = 0
const openOrderDetail = async (row: OrderRow) => {
  // 契约里 orderNum 可空（历史数据/异常行），没有订单号就不发请求
  if (!row.orderNum) {
    ElMessage.warning('该订单缺少订单号，无法查看详情')
    return
  }

  const seq = ++orderDetailSeq
  orderDetailVisible.value = true
  orderDetailLoading.value = true
  orderDetail.value = undefined
  try {
    const detail = await getAdminOrderDetail(row.orderNum)
    if (seq !== orderDetailSeq) return
    orderDetail.value = detail
  } catch (err) {
    if (seq !== orderDetailSeq) return
    ElMessage.error(err instanceof Error ? err.message : '查询订单详情失败')
    orderDetailVisible.value = false
  } finally {
    if (seq === orderDetailSeq) orderDetailLoading.value = false
  }
}

/** 行点击 → 订单详情页（TASK-FRONTEND-003 的双模式详情落在该路由） */
const openDetailPage = (row: OrderRow) => {
  if (!row.orderNum) {
    ElMessage.warning('该订单缺少订单号，无法查看详情')
    return
  }
  void router
    .push({ name: 'order-detail', params: { orderNum: row.orderNum } })
    .catch(() => undefined)
}

/** 飞行中行的「监管」→ 任务监管全屏路由（SuperviseView，只读监看） */
const openSupervise = (row: OrderRow) => {
  if (!row.orderNum) {
    ElMessage.warning('该订单缺少订单号，无法进入任务监管')
    return
  }
  void router
    .push({ name: 'order-supervise', params: { orderNum: row.orderNum } })
    .catch(() => undefined)
}

const formatAmount = (value?: number) => `¥${Number(value ?? 0).toFixed(2)}`

const formatDistance = (value?: number) => `${Number(value ?? 0).toFixed(1)} m`

/** 导出当前列表为 CSV（转义/公式注入防护见 utils/csv） */
const handleExport = () => {
  const header = ['订单号', '任务名称', '下单用户', '飞手', '金额', '距离', '状态', '更新时间']
  const rows = pagedRows.value.map((row) => [
    row.orderNum ?? '',
    row.taskName ?? '',
    row.ownerName ?? '',
    row.riderName ?? '',
    row.totalAmount ?? '',
    row.totalDistance ?? '',
    orderStatusLabel(row),
    row.updateTime ?? '',
  ])
  const csv = toCsv(header, rows)
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = `订单导出_${updatedAt.value.replace(/:/g, '')}.csv`
  link.click()
  // revokeObjectURL 延迟调用，避免下载被中断
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
  ElMessage.success(`已导出 ${rows.length} 条订单`)
}


const orderStatusTagType = (vo: AdminOrderVo | OrderRow) =>
  ORDER_STATUS_META[vo.orderStatusCode ?? -1]?.tagType ?? 'info'

const orderStatusLabel = (vo: AdminOrderVo | OrderRow) =>
  vo.orderStatusDesc ||
  ORDER_STATUS_META[vo.orderStatusCode ?? -1]?.label ||
  String(vo.orderStatusCode ?? '--')

// ==================== 任务管理（页签） ====================
const activeTab = ref<'orders' | 'tasks'>('orders')

const taskListLoaded = ref(false)
watch(activeTab, (tab) => {
  if (tab === 'tasks' && !taskListLoaded.value) {
    taskListLoaded.value = true
    void loadTasks()
  }
})

const tasks = ref<AdminTaskVo[]>([])
const tasksLoading = ref(false)
const taskTotal = ref(0)
const taskQuery = reactive({
  page: 1,
  pageSize: 10,
  status: '',
  taskNum: '',
})

const taskStatusOptions = Object.entries(TASK_STATUS_META).map(([status, meta]) => ({
  status,
  label: meta.label,
}))

let tasksSeq = 0
const loadTasks = async () => {
  const seq = ++tasksSeq
  tasksLoading.value = true
  try {
    const data = await getAdminTasks({
      page: taskQuery.page - 1,
      size: taskQuery.pageSize,
      status: taskQuery.status || undefined,
      taskNum: taskQuery.taskNum.trim() || undefined,
    })
    if (seq !== tasksSeq) return
    tasks.value = data.content
    taskTotal.value = data.totalElements ?? 0
  } catch (err) {
    if (seq === tasksSeq) ElMessage.error(err instanceof Error ? err.message : '加载任务失败')
  } finally {
    if (seq === tasksSeq) tasksLoading.value = false
  }
}

const handleTaskSearch = () => {
  taskQuery.page = 1
  void loadTasks()
}

const handleTaskReset = () => {
  taskQuery.status = ''
  taskQuery.taskNum = ''
  taskQuery.page = 1
  void loadTasks()
}

const handleTaskPageChange = (page: number) => {
  taskQuery.page = page
  void loadTasks()
}

const handleTaskSizeChange = (size: number) => {
  taskQuery.pageSize = size
  taskQuery.page = 1
  void loadTasks()
}

const taskStatusTagType = (vo: AdminTaskVo) =>
  TASK_STATUS_META[vo.taskStatus ?? '']?.tagType ?? 'info'

const taskStatusLabel = (vo: AdminTaskVo) =>
  vo.taskStatusDesc || TASK_STATUS_META[vo.taskStatus ?? '']?.label || vo.taskStatus

// ==================== 任务详情抽屉 ====================
const taskDetailVisible = ref(false)
const taskDetailLoading = ref(false)
const taskDetail = ref<AdminTaskVo>()

let taskDetailSeq = 0
const openTaskDetail = async (row: AdminTaskVo) => {
  // 契约里 taskNum 可空，没有任务号就不发请求
  if (!row.taskNum) {
    ElMessage.warning('该任务缺少任务号，无法查看详情')
    return
  }

  const seq = ++taskDetailSeq
  taskDetailVisible.value = true
  taskDetailLoading.value = true
  taskDetail.value = undefined
  try {
    const detail = await getAdminTaskDetail(row.taskNum)
    if (seq !== taskDetailSeq) return
    taskDetail.value = detail
  } catch (err) {
    if (seq !== taskDetailSeq) return
    ElMessage.error(err instanceof Error ? err.message : '查询任务详情失败')
    taskDetailVisible.value = false
  } finally {
    if (seq === taskDetailSeq) taskDetailLoading.value = false
  }
}
</script>

<template>
  <MainLayout title="订单" subtitle="全平台订单与任务：状态、飞行中高亮与筛选（与首页指标联动）。">
    <div class="flex flex-col gap-4">
      <el-tabs v-model="activeTab" class="manage-tabs">
        <el-tab-pane label="订单管理" name="orders">
          <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div class="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
              <el-select
                v-model="filters.status"
                class="md:!w-[150px]"
                clearable
                placeholder="订单状态"
                @change="applyQuery()"
              >
                <el-option
                  v-for="option in statusOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <el-select
                v-model="filters.date"
                class="md:!w-[130px]"
                clearable
                placeholder="时间范围"
                @change="applyQuery()"
              >
                <el-option
                  v-for="option in dateOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <el-select
                v-model="filters.dispute"
                class="md:!w-[150px]"
                clearable
                placeholder="争议状态"
                @change="applyQuery()"
              >
                <el-option
                  v-for="option in disputeOptions"
                  :key="option.value"
                  :label="option.label"
                  :value="option.value"
                />
              </el-select>
              <el-input
                v-model="filters.q"
                class="md:!w-[240px]"
                clearable
                placeholder="订单号 / 任务 / 用户 / 飞手"
                @keyup.enter="applyQuery()"
                @clear="applyQuery()"
              />
              <el-button type="primary" @click="applyQuery()">查询</el-button>
              <el-button @click="resetFilters">重置</el-button>
            </div>
            <div class="flex items-center gap-3">
              <span class="text-xs text-[var(--text-secondary)]">更新于 {{ updatedAt }}</span>
              <el-button size="small" @click="handleExport">
                <el-icon class="mr-1"><Download /></el-icon>
                导出当前页
              </el-button>

              <el-button :loading="loading" @click="load">刷新</el-button>
            </div>
          </div>

          <el-alert
            v-if="truncated"
            class="mt-3"
            type="warning"
            :closable="false"
            title="部分订单、任务或投诉数据未加载完整，筛选结果和飞手信息可能不完整。可按状态或时间缩小范围。"
          />

          <div class="mt-4">
            <el-table
              :data="pagedRows"
              :loading="loading"
              border
              stripe
              :row-class-name="rowClassName"
              @row-click="openDetailPage"
            >
              <el-table-column prop="orderNum" label="订单号" min-width="170" />
              <el-table-column prop="taskName" label="任务名称" min-width="150" />
              <el-table-column prop="ownerName" label="下单用户" min-width="110" />
              <el-table-column label="飞手" min-width="110">
                <template #default="scope">
                  {{ scope.row.riderName || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="金额" width="110">
                <template #default="scope">
                  {{ formatAmount(scope.row.totalAmount) }}
                </template>
              </el-table-column>
              <el-table-column label="距离" width="100">
                <template #default="scope">
                  {{ formatDistance(scope.row.totalDistance) }}
                </template>
              </el-table-column>
              <el-table-column label="状态" width="130">
                <template #default="scope">
                  <el-tag :type="orderStatusTagType(scope.row)" effect="plain">
                    {{ orderStatusLabel(scope.row) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="更新时间" min-width="170">
                <template #default="scope">
                  {{ scope.row.updateTime || '—' }}
                </template>
              </el-table-column>
              <el-table-column label="操作" width="160" fixed="right">
                <template #default="scope">
                  <el-button size="small" @click.stop="openOrderDetail(scope.row)">详情</el-button>
                  <el-button
                    v-if="scope.row.flying"
                    size="small"
                    type="primary"
                    @click.stop="openSupervise(scope.row)"
                  >
                    监管
                  </el-button>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无订单数据" :image-size="80" />
              </template>
            </el-table>

            <div class="mt-4 flex justify-center">
              <el-pagination
                background
                layout="total, sizes, prev, pager, next, jumper"
                :total="total"
                :current-page="pageNo"
                :page-size="pageSize"
                :page-sizes="PAGE_SIZES"
                @current-change="(page: number) => applyQuery({ page })"
                @size-change="(size: number) => applyQuery({ size })"
              />
            </div>
          </div>
        </el-tab-pane>

        <el-tab-pane label="任务管理" name="tasks">
          <div class="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div class="flex flex-col gap-3 md:flex-row md:flex-wrap md:items-center">
              <el-select
                v-model="taskQuery.status"
                class="md:!w-[140px]"
                clearable
                placeholder="任务状态"
              >
                <el-option
                  v-for="option in taskStatusOptions"
                  :key="option.status"
                  :label="option.label"
                  :value="option.status"
                />
              </el-select>
              <el-input
                v-model="taskQuery.taskNum"
                class="md:!w-[200px]"
                clearable
                placeholder="任务编号"
                @keyup.enter="handleTaskSearch"
              />
              <el-button type="primary" @click="handleTaskSearch">查询</el-button>
              <el-button @click="handleTaskReset">重置</el-button>
            </div>
            <el-button :loading="tasksLoading" @click="loadTasks">刷新</el-button>
          </div>

          <div class="mt-4">
            <el-table :data="tasks" :loading="tasksLoading" border stripe>
              <el-table-column prop="taskNum" label="任务编号" min-width="180" />
              <el-table-column prop="taskName" label="任务名称" min-width="150" />
              <el-table-column prop="ownerName" label="发布用户" min-width="110" />
              <el-table-column label="接单飞手" min-width="110">
                <template #default="scope">
                  {{ scope.row.riderName || '--' }}
                </template>
              </el-table-column>
              <el-table-column label="酬劳" width="110">
                <template #default="scope">
                  {{ formatAmount(scope.row.reward) }}
                </template>
              </el-table-column>
              <el-table-column label="任务状态" width="120">
                <template #default="scope">
                  <el-tag :type="taskStatusTagType(scope.row)" effect="plain">
                    {{ taskStatusLabel(scope.row) }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column label="订单状态" width="120">
                <template #default="scope">
                  <el-tag :type="orderStatusTagType(scope.row)" effect="plain">
                    {{ scope.row.orderStatusDesc || '--' }}
                  </el-tag>
                </template>
              </el-table-column>
              <el-table-column prop="taskTime" label="任务时间" min-width="170" />
              <el-table-column label="操作" width="90" fixed="right">
                <template #default="scope">
                  <el-button size="small" @click="openTaskDetail(scope.row)">详情</el-button>
                </template>
              </el-table-column>
              <template #empty>
                <el-empty description="暂无任务数据" :image-size="80" />
              </template>
            </el-table>

            <div class="mt-4 flex justify-center">
              <el-pagination
                background
                layout="total, sizes, prev, pager, next, jumper"
                :total="taskTotal"
                :current-page="taskQuery.page"
                :page-size="taskQuery.pageSize"
                :page-sizes="[10, 20, 50, 100]"
                @current-change="handleTaskPageChange"
                @size-change="handleTaskSizeChange"
              />
            </div>
          </div>
        </el-tab-pane>
      </el-tabs>
    </div>

    <el-drawer v-model="orderDetailVisible" title="订单详情" size="420px">
      <div v-loading="orderDetailLoading">
        <template v-if="orderDetail">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="订单号">{{ orderDetail.orderNum }}</el-descriptions-item>
            <el-descriptions-item label="任务">{{ orderDetail.taskName }}（{{ orderDetail.taskNum }}）</el-descriptions-item>
            <el-descriptions-item label="下单用户">{{ orderDetail.ownerName }}</el-descriptions-item>
            <el-descriptions-item label="状态">
              <el-tag :type="orderStatusTagType(orderDetail)" effect="plain">
                {{ orderStatusLabel(orderDetail) }}（{{ orderDetail.orderStatus }} / {{ orderDetail.orderStatusCode }}）
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="金额">{{ formatAmount(orderDetail.totalAmount) }}</el-descriptions-item>
            <el-descriptions-item label="距离">{{ formatDistance(orderDetail.totalDistance) }}</el-descriptions-item>
            <el-descriptions-item label="创建时间">{{ orderDetail.createTime }}</el-descriptions-item>
            <el-descriptions-item label="更新时间">{{ orderDetail.updateTime }}</el-descriptions-item>
          </el-descriptions>
        </template>
      </div>
    </el-drawer>

    <el-drawer v-model="taskDetailVisible" title="任务详情" size="460px">
      <div v-loading="taskDetailLoading">
        <template v-if="taskDetail">
          <el-descriptions :column="1" border>
            <el-descriptions-item label="任务编号">{{ taskDetail.taskNum }}</el-descriptions-item>
            <el-descriptions-item label="任务名称">{{ taskDetail.taskName }}</el-descriptions-item>
            <el-descriptions-item label="发布用户">{{ taskDetail.ownerName }}</el-descriptions-item>
            <el-descriptions-item label="接单飞手">{{ taskDetail.riderName || '--' }}</el-descriptions-item>
            <el-descriptions-item label="任务状态">
              <el-tag :type="taskStatusTagType(taskDetail)" effect="plain">
                {{ taskStatusLabel(taskDetail) }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="任务时间">{{ taskDetail.taskTime }}</el-descriptions-item>
            <el-descriptions-item label="酬劳">{{ formatAmount(taskDetail.reward) }}</el-descriptions-item>
            <el-descriptions-item label="任务说明">{{ taskDetail.description || '--' }}</el-descriptions-item>
            <el-descriptions-item label="完成说明">{{ taskDetail.completeNote || '--' }}</el-descriptions-item>
            <el-descriptions-item label="操作提示">{{ taskDetail.actionHint || '--' }}</el-descriptions-item>
            <el-descriptions-item label="关联订单">
              {{ taskDetail.orderNum || '--' }}
              <el-tag
                v-if="taskDetail.orderNum"
                class="ml-2"
                :type="orderStatusTagType(taskDetail)"
                effect="plain"
              >
                {{ taskDetail.orderStatusDesc }}
              </el-tag>
            </el-descriptions-item>
            <el-descriptions-item label="订单金额">{{ formatAmount(taskDetail.totalAmount) }}</el-descriptions-item>
          </el-descriptions>
        </template>
      </div>
    </el-drawer>
  </MainLayout>
</template>

<style scoped>
.manage-tabs {
  background: var(--bg-card);
  border-radius: 12px;
  padding: 20px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.05);
}

/* 飞行中行高亮：浅绿底 + 首列色条（REQ-FRONTEND-001 §2.1） */
:deep(.el-table .flying-row) {
  background-color: var(--success-soft);
}

:deep(.el-table .flying-row > td:first-child) {
  box-shadow: inset 3px 0 0 0 #67c23a;
}

:deep(.el-table .flying-row:hover > td) {
  background-color: var(--success-softer);
}
</style>
