<script setup lang="ts">
import { computed, onBeforeUnmount, ref, type Component } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import {
  ArrowRight,
  Avatar,
  Notebook,
  Position,
  Promotion,
  Refresh,
  Tickets,
  User,
  WarningFilled,
} from '@element-plus/icons-vue'
import { ElMessage } from 'element-plus'
import { forEachConcurrent } from '../utils/concurrency'
import MainLayout from '../layouts/MainLayout.vue'
import { getAdminComplaints, getAdminPilots } from '../api/modules/admin-query'
import { scanInProgressTasks, scanOrders } from '../api/modules/admin-scan'
import { getOrderTrajectory, getUavPosition } from '../api/modules/uav'
import type { AdminComplaint, AdminOrderVo, AdminTaskVo } from '../types/admin'
import { formatClock, formatDateTime, formatDuration } from '../utils/date'
import {
  summarizePosition,
  summarizeTrajectory,
  type TelemetrySummary,
} from '../utils/telemetry'

/**
 * 首页看板（REQ-FRONTEND-001 §1）：
 *  A. 四指标卡（点击带筛选跳订单/飞手列表）；
 *  B. 正在飞行订单表格（路线/主体/遥测摘要 + [任务监管]/[详情]，轮询刷新遥测）；
 *  C. 侧栏快捷入口 + 待办 + 今日新发 Top5。
 * 无机队启停直播控件（ADR-0004 移除项）。
 */
const router = useRouter()

interface FlyingCard {
  task: AdminTaskVo
  telemetry?: TelemetrySummary
  /** 起飞时间（首帧轨迹首点，ms）：位置接口只给最新一点，推不出已飞时长 */
  startedAt?: number | null
  /** 轨迹起点探测次数；刚起飞时轨迹可能还是空，限次重试后不再拉整条轨迹 */
  startedAtTries?: number
}

interface TodoItem {
  key: 'dispute' | 'overdue'
  title: string
  detail: string
  to: RouteLocationRaw
}

const COMPLAINT_REASON_LABELS: Record<string, string> = {
  NOT_AS_DESCRIBED: '不符描述',
  QUALITY_ISSUE: '质量问题',
  SERVICE_ISSUE: '服务问题',
  OTHER: '其他',
}

const TELEMETRY_POLL_MS = 10_000
/** 起飞时间探测上限（刚起飞时轨迹可能为空）：之后只轮询位置，不再拉整条轨迹 */
const STARTED_AT_MAX_TRIES = 3

const loading = ref(false)
const loadError = ref('')
const scanTruncated = ref(false)
const todayTruncated = ref(false)
const flyingTotal = ref<number>()
let disposed = false
const updatedAt = ref('--:--:--')
const flyingCards = ref<FlyingCard[] | undefined>(undefined)
const todayOrders = ref<AdminOrderVo[] | undefined>(undefined)
const pendingComplaintTotal = ref<number | undefined>(undefined)
const pendingComplaints = ref<AdminComplaint[]>([])
const registeredRiders = ref<number | undefined>(undefined)
const overdueWaiting = ref<{ total: number; example?: AdminOrderVo } | undefined>(undefined)

/** 路由跳转（守卫重定向/重复导航的失败对用户无意义，静默忽略） */
const go = (to: RouteLocationRaw) => {
  void router.push(to).catch(() => undefined)
}

const metricIcons: Record<string, Component> = {
  flying: Promotion,
  today: Tickets,
  dispute: WarningFilled,
  pilot: User,
}

const metrics = computed(() => [
  {
    key: 'flying',
    label: '正在飞行',
    value: flyingCards.value ? String(flyingTotal.value ?? flyingCards.value.length) : '—',
    hint: '执行中任务',
    to: { name: 'orders', query: { status: 'in_progress' } } satisfies RouteLocationRaw,
  },
  {
    key: 'today',
    label: '今日订单',
    value: todayOrders.value ? `${todayTruncated.value ? '至少 ' : ''}${todayOrders.value.length}` : '—',
    hint: '今日新建',
    to: { name: 'orders', query: { date: 'today' } } satisfies RouteLocationRaw,
  },
  {
    key: 'dispute',
    label: '待处理争议',
    value: pendingComplaintTotal.value !== undefined ? String(pendingComplaintTotal.value) : '—',
    hint: '投诉待处理',
    to: { name: 'orders', query: { dispute: 'pending' } } satisfies RouteLocationRaw,
  },
  {
    key: 'pilot',
    label: '在册飞手',
    value: String(registeredRiders.value ?? '—'),
    hint: '注册飞手总数',
    to: { name: 'pilots' } satisfies RouteLocationRaw,
  },
])

const quickEntries = [
  { label: '全部订单', icon: Tickets, to: { name: 'orders' } satisfies RouteLocationRaw },
  { label: '用户管理', icon: User, to: { name: 'users' } satisfies RouteLocationRaw },
  { label: '飞手管理', icon: Avatar, to: { name: 'pilots' } satisfies RouteLocationRaw },
  { label: '系统日志', icon: Notebook, to: { name: 'system' } satisfies RouteLocationRaw },
]

const todos = computed<TodoItem[]>(() => {
  const items: TodoItem[] = []

  if ((pendingComplaintTotal.value ?? 0) > 0) {
    const latest = pendingComplaints.value[0]
    const reason = latest?.reason ? COMPLAINT_REASON_LABELS[latest.reason] ?? latest.reason : ''
    items.push({
      key: 'dispute',
      title: `${pendingComplaintTotal.value} 条待处理争议`,
      detail: latest?.orderNum
        ? `最新 ${latest.orderNum}${reason ? ` · ${reason}` : ''}`
        : '投诉中心有待处理项',
      to: latest?.orderNum
        ? { name: 'order-detail', params: { orderNum: latest.orderNum } }
        : { name: 'orders', query: { dispute: 'pending' } },
    })
  }

  if ((overdueWaiting.value?.total ?? 0) > 0) {
    const example = overdueWaiting.value?.example
    items.push({
      key: 'overdue',
      title: `${overdueWaiting.value?.total} 单创建超 24 小时且待验收`,
      detail: example?.orderNum
        ? `例 ${example.orderNum} · 创建于 ${example.createTime ?? '—'}`
        : '创建超 24 小时仍未确认完成',
      to: example?.orderNum
        ? { name: 'order-detail', params: { orderNum: example.orderNum } }
        : { name: 'orders', query: { status: '5' } },
    })
  }

  return items
})

const todayTop5 = computed(() => (todayOrders.value ?? []).slice(0, 5))

const orderStatusLabel = (order: AdminOrderVo) => order.orderStatusDesc || order.orderStatus || '—'

const telemetrySummary = (card: FlyingCard) => {
  const telemetry = card.telemetry
  if (!telemetry) {
    return '等待设备上报'
  }
  const parts = [
    telemetry.altitude != null ? `高度 ${telemetry.altitude.toFixed(1)} m` : '',
    telemetry.speed != null ? `速度 ${telemetry.speed.toFixed(1)} m/s` : '',
    telemetry.battery != null ? `电量 ${telemetry.battery}%` : '',
    telemetry.startedAt ? `已飞 ${formatDuration(Date.now() - telemetry.startedAt)}` : '',
    telemetry.reportedAt ? `上报 ${formatClock(new Date(telemetry.reportedAt))}` : '',
  ].filter(Boolean)
  return parts.length > 0 ? parts.join(' · ') : '等待设备上报'
}

/**
 * 拉取全部飞行卡的实时遥测。
 * 每张卡首帧补一次 `/webUav/trajectory` 只为拿起飞时间（订单维度、不随轮询增长）；
 * 常态轮询走 `/webUav/position`，每次只取一个点，避免整条轨迹越飞越慢。
 * 没有作业设备（未绑定/离线）的卡回退到轨迹摘要，保持旧展示。
 */
let telemetryInFlight: Promise<void> | undefined
const refreshTelemetry = (): Promise<void> => {
  if (telemetryInFlight) return telemetryInFlight
  const cards = flyingCards.value ?? []
  telemetryInFlight = forEachConcurrent(cards, 4, async (card) => {
    if (disposed) return
    const orderNum = card.task.orderNum
    if (!orderNum) return
    try {
      const deviceId = card.task.deviceId
      if (deviceId) {
        if (card.startedAt === undefined && (card.startedAtTries ?? 0) < STARTED_AT_MAX_TRIES) {
          card.startedAtTries = (card.startedAtTries ?? 0) + 1
          const points = await getOrderTrajectory(orderNum).catch(() => [])
          if (disposed || flyingCards.value !== cards) return
          const startedAt = summarizeTrajectory(points)?.startedAt
          // 拿不到就保持 undefined：限次内下一轮再试，超过次数后只显示位置、不显示已飞时长
          card.startedAt = startedAt ?? (card.startedAtTries >= STARTED_AT_MAX_TRIES ? null : undefined)
        }
        const point = await getUavPosition(deviceId)
        if (!disposed && flyingCards.value === cards) {
          card.telemetry = summarizePosition(point, card.startedAt ?? undefined)
        }
        return
      }
      const points = await getOrderTrajectory(orderNum)
      if (!disposed && flyingCards.value === cards) card.telemetry = summarizeTrajectory(points)
    } catch {
      if (!disposed && flyingCards.value === cards) card.telemetry = undefined
    }
  }).finally(() => { telemetryInFlight = undefined })
  return telemetryInFlight
}

let telemetryTimer: ReturnType<typeof setInterval> | undefined
const stopPolling = () => {
  if (telemetryTimer !== undefined) {
    clearInterval(telemetryTimer)
    telemetryTimer = undefined
  }
}

const startPolling = () => {
  stopPolling()
  const hasTrackable = (flyingCards.value ?? []).some((card) => card.task.orderNum)
  if (hasTrackable) {
    telemetryTimer = setInterval(() => {
      void refreshTelemetry()
    }, TELEMETRY_POLL_MS)
  }
}

onBeforeUnmount(() => { disposed = true; loadSeq += 1; stopPolling() })

let loadSeq = 0
const load = async () => {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  stopPolling()
  try {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const overdueCutoff = formatDateTime(new Date(Date.now() - 24 * 3_600_000))

    const [inProgress, todayScan, complaints, riders, waitingScan] = await Promise.all([
      scanInProgressTasks(),
      scanOrders({ cutoff: formatDateTime(midnight), pageSize: 100, maxPages: 5 }),
      // 以下三项失败不阻断看板：对应指标显示「—」或折叠待办
      getAdminComplaints({ page: 0, size: 10, status: 'PENDING' }).catch(() => null),
      getAdminPilots({ page: 0, size: 1 }).catch(() => null),
      scanOrders({ status: '5', cutoff: overdueCutoff, pageSize: 100, maxPages: 5 }).catch(
        () => null,
      ),
    ])
    if (seq !== loadSeq) return

    flyingCards.value = inProgress.rows
      .filter((task) => task.taskStatus === 'IN_PROGRESS')
      .map((task) => ({ task }))
    flyingTotal.value = inProgress.totalElements
    todayTruncated.value = todayScan.truncated
    scanTruncated.value = inProgress.truncated || todayScan.truncated
    todayOrders.value = todayScan.rows
    pendingComplaints.value = complaints?.complaints ?? []
    pendingComplaintTotal.value = complaints
      ? complaints.totalElements ?? pendingComplaints.value.length
      : undefined
    registeredRiders.value = riders?.totalElements
    overdueWaiting.value = waitingScan
      ? waitingScan.truncated
        ? undefined
        : {
            total: Math.max(0, waitingScan.totalElements - waitingScan.rows.length),
            example: waitingScan.firstExcluded,
          }
      : undefined

    await refreshTelemetry()
    if (seq !== loadSeq) return
    startPolling()
    updatedAt.value = formatClock()
  } catch (err) {
    if (seq === loadSeq) {
      loadError.value = err instanceof Error ? err.message : '加载首页失败'
      ElMessage.error(loadError.value)
    }
  } finally {
    if (seq === loadSeq) {
      loading.value = false
    }
  }
}

void load()

const openOrderDetail = (orderNum?: string) => {
  if (!orderNum) {
    return
  }
  go({ name: 'order-detail', params: { orderNum } })
}

const formatAmount = (value?: number) => (value == null ? '—' : `¥${value.toFixed(2)}`)
</script>

<template>
  <MainLayout title="首页" subtitle="值守第一屏：平台指标、正在飞行订单与快捷入口。">
    <div class="dash">
      <!-- 工具栏 -->
      <div class="dash__toolbar">
        <span class="dash__updated">更新于 {{ updatedAt }}</span>
        <el-button size="small" :loading="loading" @click="load">
          <el-icon class="mr-1"><Refresh /></el-icon>
          刷新
        </el-button>
      </div>

      <el-alert v-if="loadError" :title="loadError + '，请点击刷新重试。已有数据可能已过期。'" type="error" :closable="false" />
      <el-alert v-if="scanTruncated" title="部分数据未加载完整，今日订单显示已加载数量，飞行列表仅展示部分任务。" type="warning" :closable="false" />
      <!-- 指标卡 -->
      <div class="stat-grid">
        <button
          v-for="metric in metrics"
          :key="metric.key"
          type="button"
          class="kpi"
          :data-testid="`metric-${metric.key}`"
          @click="go(metric.to)"
        >
          <div class="kpi__top">
            <span class="kpi__icon" :class="`kpi__icon--${metric.key}`">
              <el-icon><component :is="metricIcons[metric.key]" /></el-icon>
            </span>
            <span class="kpi__label">{{ metric.label }}</span>
          </div>
          <div class="kpi__value tabular-nums">{{ metric.value }}</div>
          <div class="kpi__meta">{{ metric.hint }}</div>
        </button>
      </div>

      <!-- 主区 + 侧栏 -->
      <div class="dash-grid">
        <section class="panel-card panel">
          <div class="panel__head">
            <div class="panel__title">
              <span class="live-dot"></span>
              正在飞行的订单
              <span v-if="flyingCards?.length" class="panel__count">{{ flyingCards.length }}</span>
            </div>
            <el-tag v-if="flyingCards?.length" type="success" effect="light" size="small">
              飞行中
            </el-tag>
          </div>

          <el-table v-if="flyingCards?.length" :data="flyingCards" size="small" data-testid="flying-table">
            <el-table-column label="订单" min-width="150">
              <template #default="{ row }">
                <div class="order-cell">
                  <span class="live-dot live-dot--sm"></span>
                  <span class="order-num tabular-nums">{{ row.task.orderNum || '暂无订单号' }}</span>
                </div>
              </template>
            </el-table-column>
            <el-table-column label="任务" min-width="140" show-overflow-tooltip>
              <template #default="{ row }">{{ row.task.taskName || '—' }}</template>
            </el-table-column>
            <el-table-column label="用户" min-width="90">
              <template #default="{ row }">
                <button
                  type="button"
                  class="link"
                  @click="go({ name: 'users', query: row.task.userId ? { id: String(row.task.userId) } : {} })"
                >
                  {{ row.task.ownerName || '—' }}
                </button>
              </template>
            </el-table-column>
            <el-table-column label="飞手" min-width="90">
              <template #default="{ row }">
                <button
                  type="button"
                  class="link"
                  @click="go({ name: 'pilots', query: row.task.riderName ? { q: row.task.riderName } : {} })"
                >
                  {{ row.task.riderName || '—' }}
                </button>
              </template>
            </el-table-column>
            <el-table-column label="金额" width="110" align="right">
              <template #default="{ row }">
                <span class="amount tabular-nums">{{ formatAmount(row.task.totalAmount) }}</span>
              </template>
            </el-table-column>
            <el-table-column label="遥测" min-width="190">
              <template #default="{ row }">
                <span class="telemetry" :title="telemetrySummary(row)">
                  {{ telemetrySummary(row) }}
                </span>
              </template>
            </el-table-column>
            <el-table-column label="操作" width="132" fixed="right">
              <template #default="{ row }">
                <el-button
                  v-if="row.task.orderNum"
                  size="small"
                  type="primary"
                  link
                  @click="go({ name: 'order-supervise', params: { orderNum: row.task.orderNum } })"
                >
                  监管
                </el-button>
                <el-button
                  v-if="row.task.orderNum"
                  size="small"
                  link
                  @click="openOrderDetail(row.task.orderNum)"
                >
                  详情
                </el-button>
                <span v-else class="text-xs" style="color: var(--text-faint)">订单生成中</span>
              </template>
            </el-table-column>
          </el-table>

          <div v-else-if="!loading && !loadError" class="map-placeholder">
            <div class="map-placeholder__grid"></div>
            <div class="map-placeholder__center">
              <span class="map-placeholder__icon"><el-icon><Position /></el-icon></span>
              <span class="map-placeholder__title">当前无飞行作业</span>
              <span class="map-placeholder__desc">可前往订单列表查看任务与履约记录</span>
              <el-button type="primary" plain size="small" @click="go({ name: 'orders' })">
                查看全部订单
              </el-button>
            </div>
          </div>
        </section>

        <aside class="rail">
          <section class="panel-card panel">
            <div class="panel__title">快捷操作</div>
            <div class="quick-grid">
              <button
                v-for="entry in quickEntries"
                :key="entry.label"
                type="button"
                class="quick-item"
                @click="go(entry.to)"
              >
                <span class="quick-item__icon">
                  <el-icon><component :is="entry.icon" /></el-icon>
                </span>
                <span class="quick-item__label">{{ entry.label }}</span>
              </button>
            </div>
          </section>

          <section v-if="todos.length > 0" class="panel-card panel">
            <div class="panel__title">待办</div>
            <div class="todo-list">
              <button
                v-for="item in todos"
                :key="item.key"
                type="button"
                class="todo"
                @click="go(item.to)"
              >
                <span class="todo__dot" :class="`todo__dot--${item.key}`"></span>
                <span class="todo__body">
                  <span class="todo__title">{{ item.title }}</span>
                  <span class="todo__detail">{{ item.detail }}</span>
                </span>
                <el-icon class="todo__arrow"><ArrowRight /></el-icon>
              </button>
            </div>
          </section>
        </aside>
      </div>

      <!-- 今日新发 -->
      <section v-if="todayOrders?.length" class="panel-card panel">
        <div class="panel__head">
          <div class="panel__title">今日新发</div>
          <button type="button" class="link" @click="go({ name: 'orders', query: { date: 'today' } })">
            查看全部
            <el-icon class="ml-1"><ArrowRight /></el-icon>
          </button>
        </div>
        <el-table :data="todayTop5" size="small" data-testid="today-table" @row-click="(row: AdminOrderVo) => openOrderDetail(row.orderNum)">
          <el-table-column prop="orderNum" label="订单号" min-width="150" />
          <el-table-column prop="ownerName" label="用户" min-width="90" />
          <el-table-column label="状态" width="120">
            <template #default="scope">
              {{ orderStatusLabel(scope.row) }}
            </template>
          </el-table-column>
          <el-table-column label="金额" width="110" align="right">
            <template #default="scope">
              <span class="amount tabular-nums">{{ formatAmount(scope.row.totalAmount) }}</span>
            </template>
          </el-table-column>
        </el-table>
      </section>
    </div>
  </MainLayout>
</template>

<style scoped>
.dash {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dash__toolbar {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  height: 28px;
}

.dash__updated {
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}

/* ---------- 指标卡 ---------- */
.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 12px;
}

.kpi {
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-card);
  background: var(--bg-card);
  box-shadow: var(--shadow-card);
  padding: 14px 16px;
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease, transform 0.15s ease;
}

.kpi:hover {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-float);
}

.kpi__top {
  display: flex;
  align-items: center;
  gap: 10px;
}

.kpi__icon {
  width: 32px;
  height: 32px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 7px;
  font-size: 16px;
}

.kpi__icon--flying { background: var(--kpi-flying-soft); color: var(--kpi-flying); }
.kpi__icon--today { background: var(--kpi-today-soft); color: var(--kpi-today); }
.kpi__icon--dispute { background: var(--kpi-dispute-soft); color: var(--kpi-dispute); }
.kpi__icon--pilot { background: var(--kpi-pilot-soft); color: var(--kpi-pilot); }

.kpi__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
}

.kpi__value {
  font-size: 26px;
  font-weight: 600;
  line-height: 1;
  color: var(--text-strong);
}

.kpi__meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-faint);
  padding-top: 8px;
  border-top: 1px solid var(--border);
}

/* ---------- 面板通用 ---------- */
.panel {
  padding: 14px 16px;
}

.panel__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 12px;
}

.panel__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-strong);
}

.panel__count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: 9px;
  background: var(--brand);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
}

/* ---------- 飞行状态点 ---------- */
.live-dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
  background: var(--success);
  box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.4);
  animation: pulse 2s infinite;
}

.live-dot--sm {
  width: 6px;
  height: 6px;
}

@keyframes pulse {
  0% { box-shadow: 0 0 0 0 rgba(5, 150, 105, 0.4); }
  70% { box-shadow: 0 0 0 5px rgba(5, 150, 105, 0); }
  100% { box-shadow: 0 0 0 0 rgba(5, 150, 105, 0); }
}

.order-cell {
  display: flex;
  align-items: center;
  gap: 8px;
}

.order-num {
  font-weight: 500;
  color: var(--text-strong);
}

.amount {
  font-weight: 600;
  color: var(--text-strong);
}

.telemetry {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.link {
  border: none;
  background: transparent;
  padding: 0;
  color: var(--brand);
  font-size: inherit;
  font-weight: 500;
  cursor: pointer;
}

.link:hover {
  color: var(--brand-strong);
  text-decoration: underline;
}

/* ---------- 地图占位 ---------- */
.map-placeholder {
  position: relative;
  height: 320px;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  overflow: hidden;
  background: #0b1220;
}

.map-placeholder__grid {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(148, 163, 184, 0.08) 1px, transparent 1px),
    linear-gradient(90deg, rgba(148, 163, 184, 0.08) 1px, transparent 1px);
  background-size: 32px 32px;
}

.map-placeholder__center {
  position: relative;
  height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
}

.map-placeholder__icon {
  font-size: 30px;
  color: #3b82f6;
}

.map-placeholder__title {
  font-size: 14px;
  font-weight: 600;
  color: #cbd5e1;
}

.map-placeholder__desc {
  font-size: 12px;
  color: #64748b;
  margin-bottom: 4px;
}

/* ---------- 空状态 ---------- */
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 32px 16px;
  text-align: center;
}

.empty__icon {
  width: 44px;
  height: 44px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--bg-sunken);
  color: var(--text-faint);
  font-size: 22px;
  margin-bottom: 4px;
}

.empty__title {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-strong);
}

.empty__desc {
  font-size: 12px;
  color: var(--text-faint);
  margin-bottom: 8px;
}

/* ---------- 主次两栏 ---------- */
.dash-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 280px;
  gap: 16px;
  align-items: start;
}

.rail {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* ---------- 快捷操作 ---------- */
.quick-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 8px;
  margin-top: 12px;
}

.quick-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--bg-sunken);
  padding: 10px 8px;
  cursor: pointer;
  transition: border-color 0.15s ease, background-color 0.15s ease;
}

.quick-item:hover {
  border-color: var(--brand);
  background: var(--brand-soft);
}

.quick-item:hover .quick-item__icon {
  color: var(--brand-strong);
}

.quick-item__icon {
  font-size: 18px;
  color: var(--brand);
}

.quick-item__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-regular);
}

/* ---------- 待办 ---------- */
.todo-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 12px;
}

.todo {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius-inner);
  background: var(--bg-sunken);
  padding: 10px 12px;
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.todo:hover {
  border-color: var(--border-strong);
}

.todo__dot {
  width: 8px;
  height: 8px;
  flex-shrink: 0;
  border-radius: 50%;
}

.todo__dot--dispute { background: var(--warning); }
.todo__dot--overdue { background: var(--danger); }

.todo__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.todo__title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-strong);
}

.todo__detail {
  font-size: 12px;
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.todo__arrow {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--text-faint);
}

/* ---------- 响应式 ---------- */
@media (max-width: 1200px) {
  .dash-grid {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 1024px) {
  .stat-grid {
    grid-template-columns: repeat(2, 1fr);
  }
}

@media (max-width: 640px) {
  .stat-grid {
    grid-template-columns: 1fr;
  }
}
</style>
