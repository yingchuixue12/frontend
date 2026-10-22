import { getAdminComplaints, getAdminOrders, getAdminTasks } from './admin-query'
import type { AdminComplaint, AdminOrderVo, AdminTaskVo } from '../../types/admin'

// 首页看板与订单列表的取数编排。
// 后端 /admin/orders 只支持「状态 / 订单号 / 任务号」过滤，日期、关键字、争议、执行中
// 等筛选都得在前端做，因此需要按页扫描候选集；所有扫描一律封顶（maxPages × pageSize），
// 到达上限仍没取完就置 truncated，由调用方提示「已截断」。
// 编号（订单号/任务号）是后端的精确过滤条件，调用方应先用 classifyAdminKeyword 识别，
// 再通过 orderNum/taskNum 下推到服务端，不要走扫描。

/** 订单号格式：MO + 17 位时间 + 4 位用户ID + 4 位随机数（后端 OrderIdGenerator） */
const ORDER_NUM_RE = /^MO\d{25}$/i
/** 任务号格式：RT + 17 位时间 + 4 位用户ID + 4 位随机数（后端 RouteIdGenerator） */
const TASK_NUM_RE = /^RT\d{25}$/i

export interface KeywordQuery {
  kind: 'orderNum' | 'taskNum' | 'text'
  /** orderNum/taskNum：归一为大写的完整编号；text：归一为小写去空白的关键字 */
  value: string
}

/**
 * 区分「编号」与普通关键字。
 * 只认完整格式：半截编号继续按关键字模糊扫描，避免用户输到一半时被精确匹配成空结果。
 */
export const classifyAdminKeyword = (raw: string): KeywordQuery => {
  const keyword = raw.trim()
  if (ORDER_NUM_RE.test(keyword)) return { kind: 'orderNum', value: keyword.toUpperCase() }
  if (TASK_NUM_RE.test(keyword)) return { kind: 'taskNum', value: keyword.toUpperCase() }
  return { kind: 'text', value: keyword.toLowerCase() }
}

/** 扫描页大小（后端单页上限 100） */
export const SCAN_PAGE_SIZE = 100
/** 扫描页数上限：10 页 × 100 = 1000 条候选 */
export const SCAN_MAX_PAGES = 10
/** 任务索引页数上限（取飞手名/执行中标记） */
export const TASK_INDEX_MAX_PAGES = 5

export interface ScanPage<T> {
  rows: T[]
  /** 到达扫描上限仍未取全 */
  truncated: boolean
  /** 服务端该查询的总条数（首个响应页的 totalElements） */
  totalElements: number
  /** 因 cutoff 提前停止时，第一个落在下界之外的行（调用方常取作超期样例） */
  firstExcluded?: T
}

/**
 * 按 createTime 倒序扫描订单。
 * cutoff（'yyyy-MM-dd HH:mm:ss'，含）：命中早于该时刻的行即停止——服务端已按创建时间
 * 倒序，后续只会更早；被 cutoff 挡掉的首个行留在 firstExcluded。
 */
export const scanOrders = async (options: {
  status?: string
  cutoff?: string
  /** 订单号精确过滤（服务端） */
  orderNum?: string
  /** 任务号精确过滤（服务端） */
  taskNum?: string
  pageSize?: number
  maxPages?: number
} = {}): Promise<ScanPage<AdminOrderVo>> => {
  const pageSize = options.pageSize ?? SCAN_PAGE_SIZE
  const maxPages = options.maxPages ?? SCAN_MAX_PAGES
  const rows: AdminOrderVo[] = []
  let totalElements = 0
  let firstExcluded: AdminOrderVo | undefined

  for (let page = 0; page < maxPages; page += 1) {
    const data = await getAdminOrders({
      page,
      size: pageSize,
      status: options.status,
      orderNum: options.orderNum,
      taskNum: options.taskNum,
    })
    totalElements = data.totalElements ?? totalElements
    const content = data.content ?? []

    let hitCutoff = false
    for (const order of content) {
      const created = order.createTime ?? ''
      if (options.cutoff && created && created < options.cutoff) {
        firstExcluded = order
        hitCutoff = true
        break
      }
      rows.push(order)
    }

    if (
      hitCutoff ||
      content.length < pageSize ||
      rows.length >= totalElements
    ) {
      return { rows, truncated: false, totalElements, firstExcluded }
    }
    if (page === maxPages - 1) {
      return { rows, truncated: true, totalElements, firstExcluded }
    }
  }

  return { rows, truncated: false, totalElements, firstExcluded }
}

/** 扫描任务列表（status：IDLE / IN_PROGRESS / COMPLETED） */
export const scanTasks = async (options: {
  status?: string
  /** 任务号精确过滤（服务端） */
  taskNum?: string
  pageSize?: number
  maxPages?: number
} = {}): Promise<ScanPage<AdminTaskVo>> => {
  const pageSize = options.pageSize ?? SCAN_PAGE_SIZE
  const maxPages = options.maxPages ?? SCAN_MAX_PAGES
  const rows: AdminTaskVo[] = []
  let totalElements = 0

  for (let page = 0; page < maxPages; page += 1) {
    const data = await getAdminTasks({
      page,
      size: pageSize,
      status: options.status,
      taskNum: options.taskNum,
    })
    totalElements = data.totalElements ?? totalElements
    const content = data.content ?? []
    rows.push(...content)

    if (content.length < pageSize || rows.length >= totalElements) {
      return { rows, truncated: false, totalElements }
    }
    if (page === maxPages - 1) {
      return { rows, truncated: true, totalElements }
    }
  }

  return { rows, truncated: false, totalElements }
}

/** 任务索引：taskNum → 任务。订单列表据此补飞手名与「执行中」高亮。 */
export const buildTaskIndex = async () => {
  const { rows, truncated } = await scanTasks({ pageSize: SCAN_PAGE_SIZE, maxPages: TASK_INDEX_MAX_PAGES })
  const index = new Map<string, AdminTaskVo>()
  for (const task of rows) {
    if (task.taskNum) {
      index.set(task.taskNum, task)
    }
  }
  return { index, truncated }
}

/** 执行中任务（首页飞行卡、订单列表 in_progress 筛选与置顶） */
export const scanInProgressTasks = async (
  options: { taskNum?: string } = {},
): Promise<ScanPage<AdminTaskVo>> =>
  scanTasks({ status: 'IN_PROGRESS', taskNum: options.taskNum, maxPages: SCAN_MAX_PAGES })

export interface PendingComplaints {
  rows: AdminComplaint[]
  truncated: boolean
}

/** 待处理投诉（status=PENDING）：订单列表 dispute=pending 筛选与首页待办共用 */
export const fetchPendingComplaints = async (pageSize = SCAN_PAGE_SIZE): Promise<PendingComplaints> => {
  const rows: AdminComplaint[] = []
  for (let page = 0; page < SCAN_MAX_PAGES; page += 1) {
    const data = await getAdminComplaints({ page, size: pageSize, status: 'PENDING' })
    const content = data.complaints ?? []
    rows.push(...content)
    if (content.length < pageSize || rows.length >= (data.totalElements ?? Infinity) ||
      (data.totalPages != null && page + 1 >= data.totalPages)) {
      return { rows, truncated: false }
    }
  }
  return { rows, truncated: true }
}
