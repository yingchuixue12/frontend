import { apiGet, expectData, type Schemas } from '../contract'
import { getAdminComplaints } from './admin-query'
import { getOrderTrajectory, getUavPosition } from './uav'
import {
  summarizePosition,
  summarizeTrajectory,
  type TelemetrySummary,
} from '../../utils/telemetry'
import type { AdminComplaint, AdminOrderVo, AdminTaskVo } from '../../types/admin'

/**
 * 订单详情双模式（TASK-FRONTEND-003）的取数与 VO 映射——撮合字段的唯一读取点。
 *
 * 契约已同步（TASK-PLATFORM-001）：matchStatus / quotedAmount / scheduledTime / userConfirmedAt /
 * riderConfirmedAt / cargo* / deviceId 均来自生成类型；本文件只做「多来源 → 单一视图模型」的收敛，
 * 上层不得散落判空。
 */

/** 撮合字段视图模型（来源：契约 TaskVo / AdminTaskVo 的子集，读取点见 readMatchFields） */
export interface MatchProgressFields {
  matchStatus?: string
  quotedAmount?: number
  scheduledTime?: string
  userConfirmedAt?: string
  riderConfirmedAt?: string
  cargoWeightKg?: number
  cargoCategory?: string
}

/** 任务详情（契约 TaskVo：deviceId + liveState + 撮合字段），`/task/detail` 的 data */
export type TaskProgressive = Schemas['TaskVo']

/** 应征记录（契约 TaskApplicationVO） */
export type TaskApplicationVo = Schemas['TaskApplicationVO']

/** 任务履约证据（后端 `/tasks/{taskNum}/attachments` 的 List<Map> 条目） */
export interface TaskEvidenceVo {
  objectKey?: string
  fileName?: string
  contentType?: string
  sizeBytes?: number
  uploaderId?: number
  createTime?: string
  /** presigned 下载地址（15 分钟有效） */
  downloadUrl?: string
}

export interface TimelineStep {
  key: 'publish' | 'apply' | 'select' | 'pay' | 'confirm' | 'fly' | 'close'
  label: string
  /** 后端未回显该节点时间时为 undefined */
  time?: string
  /** unknown = 数据暂不可用（接口未同步/无权），既非完成也非待办 */
  state: 'done' | 'pending' | 'unknown'
  note?: string
}

export interface PricingView {
  /** 成交金额（=选定应征时锁定的系统报价，ADR-0003 禁止改价） */
  totalAmount?: number
  /** 系统报价：撮合字段优先，其次选定应征记录的 quotedAmount */
  quotedAmount?: number
  /** 任务奖励（服务端按航点距离计价的参考值） */
  reward?: number
  distance?: number
}

/**
 * 撮合字段的**唯一读取点**：从 `/task/detail`（TaskVo）或 `/admin/tasks/{taskNum}`（AdminTaskVo）
 * 任一来源读出撮合字段；来源没有该字段时保持 undefined。
 */
export const readMatchFields = (
  source: AdminTaskVo | TaskProgressive | undefined,
): MatchProgressFields => {
  if (!source) {
    return {}
  }
  const raw = source as Partial<MatchProgressFields>
  return {
    matchStatus: raw.matchStatus,
    quotedAmount: raw.quotedAmount,
    scheduledTime: raw.scheduledTime,
    userConfirmedAt: raw.userConfirmedAt,
    riderConfirmedAt: raw.riderConfirmedAt,
    cargoWeightKg: raw.cargoWeightKg,
    cargoCategory: raw.cargoCategory,
  }
}

/** GET /task/detail（用户侧任务详情：deviceId + liveState + 撮合字段）；失败/无权 → null 降级 */
export const fetchTaskLiveDetail = async (taskNum: string): Promise<TaskProgressive | null> => {
  try {
    const body = await apiGet('/task/detail', { params: { taskNum } })
    return expectData(body, '查询任务详情失败')
  } catch (err) {
    console.warn('[order-supervision] 任务详情（图传上下文）不可用：', err)
    return null
  }
}

/**
 * GET /task/{taskNum}/applications：应征列表（飞手/机型/载重/系统报价/时间）；
 * 端点不可用或无权 → null，区块降级占位。
 */
export const fetchTaskApplications = async (
  taskNum: string,
): Promise<TaskApplicationVo[] | null> => {
  try {
    const body = await apiGet('/task/{taskNum}/applications', { path: { taskNum } })
    return expectData(body, '查询应征列表失败')
  } catch (err) {
    console.warn('[order-supervision] 应征列表不可用：', err)
    return null
  }
}

/** GET /tasks/{taskNum}/attachments：履约证据（presigned 下载地址逐条返回）；失败/无权 → null */
export const fetchTaskEvidence = async (taskNum: string): Promise<TaskEvidenceVo[] | null> => {
  try {
    const body = await apiGet('/tasks/{taskNum}/attachments', { path: { taskNum } })
    // 后端返回 List<Map<String,Object>>；契约类型为索引签名 → 在此一处收敛为证据视图模型
    return expectData(body, '查询证据列表失败') as unknown as TaskEvidenceVo[]
  } catch (err) {
    console.warn('[order-supervision] 证据列表不可用：', err)
    return null
  }
}

/** 争议扫描页数上限（后端投诉列表无 orderNum 过滤；每页 100，最多 500 条） */
const COMPLAINT_SCAN_PAGES = 5

/** GET /admin/complaint/list → 过滤出本订单的投诉；接口失败 → null */
export const fetchOrderComplaints = async (orderNum: string): Promise<AdminComplaint[] | null> => {
  try {
    const matched: AdminComplaint[] = []
    for (let page = 0; page < COMPLAINT_SCAN_PAGES; page += 1) {
      const data = await getAdminComplaints({ page, size: 100 })
      const rows = data.complaints ?? []
      matched.push(...rows.filter((item) => item.orderNum === orderNum))
      if (rows.length < 100 || page + 1 >= (data.totalPages ?? Infinity) ||
        (page + 1) * 100 >= (data.totalElements ?? Infinity)) return matched
    }
    // The capped scan cannot establish a complete complaint history.
    return null
  } catch (err) {
    console.warn('[order-supervision] 投诉列表不可用：', err)
    return null
  }
}

/** GET /webUav/trajectory → 遥测摘要（高度/速度/电量/经纬度/最后上报）；失败 → null */
export const fetchOrderTelemetry = async (orderNum: string): Promise<TelemetrySummary | null> => {
  try {
    return summarizeTrajectory(await getOrderTrajectory(orderNum)) ?? null
  } catch (err) {
    console.warn('[order-supervision] 遥测轨迹不可用：', err)
    return null
  }
}

/**
 * 遥测轮询用 `/webUav/position` 取最新一点，代替早期每 10 秒拉整条
 * `/webUav/trajectory`（订单全量点位，越飞越慢）。单点推不出起飞时间，
 * 由调用方一次性取轨迹起点后经 startedAt 传入；缺失只影响「已飞时长」。
 */
export const fetchOrderPosition = async (
  deviceId: string,
  startedAt?: number | null,
): Promise<TelemetrySummary | null> => {
  try {
    return summarizePosition(await getUavPosition(deviceId), startedAt ?? undefined) ?? null
  } catch (err) {
    console.warn('[order-supervision] 实时位置不可用：', err)
    return null
  }
}

/** 起飞时间：订单首帧轨迹的首点时间戳；无轨迹/接口失败 → null（不阻断轮询） */
export const fetchOrderStartedAt = async (orderNum: string): Promise<number | null> => {
  try {
    return summarizeTrajectory(await getOrderTrajectory(orderNum))?.startedAt ?? null
  } catch (err) {
    console.warn('[order-supervision] 轨迹起点不可用：', err)
    return null
  }
}

export interface TimelineInput {
  order?: AdminOrderVo
  task?: AdminTaskVo
  match?: MatchProgressFields
  /** null/undefined = 应征数据暂不可用（unknown）；[] = 确实无人应征 */
  applications?: TaskApplicationVo[] | null
}

/**
 * 撮合时间线：发布 → 应征 → 选定 → 支付 → 双确认 → 执飞 → 结案。
 * 时间戳直接取契约回显字段（order.createTime / paidAt / userConfirmedAt / riderConfirmedAt、
 * task.createTime、appliedAt），完成态由订单状态码 × 任务状态推导，上层只负责渲染；
 * 契约未回显的时间（历史订单/未走完的节点）仍为 undefined，渲染层显示「—」。
 */
export const buildMatchTimeline = (input: TimelineInput): TimelineStep[] => {
  const { order, task, match, applications } = input
  const statusCode = order?.orderStatusCode ?? -1
  const hasOrder = Boolean(order)
  const paid = [1, 3, 4, 5, 6].includes(statusCode)
  const cancelled = statusCode === 2
  const closed = statusCode === 4
  const flying = task?.taskStatus === 'IN_PROGRESS'
  const finished = task?.taskStatus === 'COMPLETED'

  // 双确认时间：订单 VO 优先（下单/接单确认的记录方），撮合字段（任务详情）兜底
  const confirmTimes = [
    order?.userConfirmedAt ?? match?.userConfirmedAt,
    order?.riderConfirmedAt ?? match?.riderConfirmedAt,
  ].filter((time): time is string => Boolean(time))
  const confirmTime = confirmTimes.sort()[confirmTimes.length - 1]

  const applyTimes = (applications ?? [])
    .map((item) => item.appliedAt)
    .filter((time): time is string => Boolean(time))
    .sort()
  const applyTime = applyTimes[0]

  return [
    {
      key: 'publish',
      label: '发布',
      time: task?.createTime,
      state: task ? 'done' : 'unknown',
    },
    {
      key: 'apply',
      label: '应征',
      time: applyTime,
      state: applications ? (applications.length > 0 ? 'done' : 'pending') : 'unknown',
      note: applications
        ? applications.length > 0
          ? undefined
          : '暂无飞手应征'
        : '应征数据暂不可用',
    },
    {
      key: 'select',
      label: '选定下单',
      time: order?.createTime,
      state: hasOrder ? 'done' : 'pending',
      note: cancelled ? '订单已取消' : undefined,
    },
    {
      key: 'pay',
      label: '支付',
      time: order?.paidAt,
      state: paid || order?.paidAt ? 'done' : 'pending',
      note: cancelled ? '订单已取消，流程终止' : undefined,
    },
    {
      key: 'confirm',
      label: '双确认',
      time: confirmTime,
      state: confirmTime ? 'done' : flying || finished ? 'done' : 'pending',
      note: confirmTime
        ? undefined
        : flying || finished
          ? '已双确认（确认时间后端未回显）'
          : '待双方确认约定作业时间',
    },
    {
      key: 'fly',
      label: '执飞',
      state: flying || finished ? 'done' : 'pending',
      note: flying ? '执行中' : undefined,
    },
    {
      key: 'close',
      label: '结案',
      state: closed ? 'done' : 'pending',
      note: cancelled ? '订单已取消' : undefined,
    },
  ]
}

export interface PricingInput {
  order?: AdminOrderVo
  task?: AdminTaskVo
  match?: MatchProgressFields
  applications?: TaskApplicationVo[] | null
}

/** 计价视图（金额一律只读展示；ADR-0003：成交价=系统报价，禁止改价） */
export const buildPricing = (input: PricingInput): PricingView => {
  const selected = (input.applications ?? []).find((item) => item.status === 'SELECTED')
  return {
    totalAmount: input.order?.totalAmount ?? undefined,
    quotedAmount: input.match?.quotedAmount ?? selected?.quotedAmount ?? undefined,
    reward: input.task?.reward ?? undefined,
    distance: input.order?.totalDistance ?? undefined,
  }
}
