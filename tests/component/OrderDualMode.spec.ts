import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import OrderDetailView from '../../src/views/OrderDetailView.vue'
import SuperviseView from '../../src/views/SuperviseView.vue'
import router from '../../src/router'
import { clearStoredSession, setStoredSession } from '../../src/api/session'
import type { AuthSession } from '../../src/types/auth'
import type { LiveCredentials } from '../../src/types/uav'
import type { AdminComplaint, AdminOrderVo, AdminTaskVo, OrderGpsPoint } from '../../src/types/admin'
import type {
  TaskApplicationVo,
  TaskEvidenceVo,
  TaskProgressive,
} from '../../src/api/modules/order-supervision'

const {
  getAdminOrderDetail,
  getAdminTaskDetail,
  fetchTaskLiveDetail,
  fetchTaskApplications,
  fetchTaskEvidence,
  fetchOrderComplaints,
  getOrderTrajectory,
  getUavPosition,
  requestStartLive,
  closeLive,
  watchLiveStop,
  getPullCredentials,
  leaveLive,
} = vi.hoisted(() => ({
  getAdminOrderDetail: vi.fn(),
  getAdminTaskDetail: vi.fn(),
  fetchTaskLiveDetail: vi.fn(),
  fetchTaskApplications: vi.fn(),
  fetchTaskEvidence: vi.fn(),
  fetchOrderComplaints: vi.fn(),
  getOrderTrajectory: vi.fn(),
  getUavPosition: vi.fn(),
  requestStartLive: vi.fn(),
  closeLive: vi.fn(),
  watchLiveStop: vi.fn(),
  getPullCredentials: vi.fn(),
  leaveLive: vi.fn(),
}))

vi.mock('../../src/api/modules/admin-query', async () => {
  const actual = (await vi.importActual('../../src/api/modules/admin-query')) as Record<
    string,
    unknown
  >
  return { ...actual, getAdminOrderDetail, getAdminTaskDetail }
})

// 侧载数据源（应征/证据/投诉/图传上下文）在此 mock；纯函数构建器（时间线/计价/字段读取）走真实实现
vi.mock('../../src/api/modules/order-supervision', async () => {
  const actual = (await vi.importActual(
    '../../src/api/modules/order-supervision',
  )) as Record<string, unknown>
  return {
    ...actual,
    fetchTaskLiveDetail,
    fetchTaskApplications,
    fetchTaskEvidence,
    fetchOrderComplaints,
  }
})

// 监管只允许「拉流」（getPullCredentials）；开播/停播/观看轮询三者必须保持零调用
vi.mock('../../src/api/modules/live', () => ({
  requestStartLive,
  closeLive,
  watchLiveStop,
  getPullCredentials,
  leaveLive,
}))

vi.mock('../../src/api/modules/uav', async () => {
  const actual = (await vi.importActual('../../src/api/modules/uav')) as Record<string, unknown>
  return { ...actual, getOrderTrajectory, getUavPosition }
})

// 真实 TRTC SDK 在测试环境不可用；只验「只读接入 → 渲染播放器」这一行为
vi.mock('../../src/components/TrtcPlayer.vue', () => ({
  default: {
    name: 'TrtcPlayerStub',
    props: ['credentials'],
    template: '<div class="trtc-stub" />',
  },
}))

const inactiveOrder: AdminOrderVo = {
  orderNum: 'ORD-A',
  userId: 1,
  ownerName: '王五',
  taskNum: 'T1',
  taskName: '工地吊运',
  totalAmount: 980,
  totalDistance: 1250,
  orderStatusCode: 4,
  orderStatus: 'COMPLETED',
  orderStatusDesc: '已完成',
  createTime: '2026-09-26 09:00:00',
  updateTime: '2026-09-26 18:00:00',
}

const inactiveTask: AdminTaskVo = {
  taskNum: 'T1',
  taskName: '工地吊运',
  taskStatus: 'COMPLETED',
  taskStatusDesc: '执行完毕',
  riderName: '李四',
  actionHint: '订单已结案',
  reward: 1000,
}

const activeOrder: AdminOrderVo = {
  ...inactiveOrder,
  orderNum: 'ORD-B',
  taskNum: 'T9',
  orderStatusCode: 1,
  orderStatus: 'PAID',
  orderStatusDesc: '已支付',
}

const activeTask: AdminTaskVo = {
  taskNum: 'T9',
  taskName: '山顶吊运',
  taskStatus: 'IN_PROGRESS',
  taskStatusDesc: '执行中',
  riderName: '李四',
  actionHint: '作业执行中',
  orderNum: 'ORD-B',
  orderStatusCode: 1,
  orderStatus: 'PAID',
}

const liveDetailFixture: TaskProgressive = {
  taskNum: 'T9',
  deviceId: 'DJI-9001',
  liveState: 'RUNNING',
  matchStatus: 'CONFIRMED',
  quotedAmount: 980,
  scheduledTime: '2026-09-26 14:00:00',
  userConfirmedAt: '2026-09-26 12:00:00',
  riderConfirmedAt: '2026-09-26 12:05:00',
}

const applicationsFixture: TaskApplicationVo[] = [
  {
    applicationId: 11,
    riderId: 7,
    riderName: '张飞手',
    aircraftModelName: 'DJI FlyCart 30',
    modelCode: 'FC30',
    maxPayloadKg: 30,
    quotedAmount: 980,
    status: 'SELECTED',
    appliedAt: '2026-09-26 10:00:00',
  },
  {
    applicationId: 12,
    riderId: 8,
    riderName: '王飞手',
    aircraftModelName: 'DJI M350 RTK',
    modelCode: 'M350RTK',
    maxPayloadKg: 2.7,
    quotedAmount: 1200,
    status: 'ACTIVE',
    appliedAt: '2026-09-26 10:05:00',
  },
]

const evidenceFixture: TaskEvidenceVo[] = [
  {
    objectKey: 'task/T1/evidence-1.jpg',
    fileName: '吊运前照片.jpg',
    contentType: 'image/jpeg',
    sizeBytes: 2_097_152,
    createTime: '2026-09-26 13:00:00',
    downloadUrl: 'https://cdn.example.com/evidence-1.jpg',
  },
]

const complaintFixture: AdminComplaint = {
  id: 3,
  orderNum: 'ORD-A',
  status: 'PENDING',
  reason: 'QUALITY_ISSUE',
  description: '货品交付时有磕碰',
  createTime: '2026-09-26 15:00:00',
  userId: 1,
  refundAmount: 100,
}

const trajectoryFixture: OrderGpsPoint[] = [
  {
    altitude: 30,
    speed: 4.2,
    battery: 90,
    latitude: 31.2304,
    longitude: 121.4737,
    timestamp: 1_761_500_000_000,
    flightStatus: 1,
    operation: '吊运',
  },
  {
    altitude: 42.5,
    speed: 5.5,
    battery: 78,
    latitude: 31.231,
    longitude: 121.474,
    timestamp: 1_761_500_600_000,
    flightStatus: 1,
    operation: '吊运',
  },
]

const credentialsFixture: LiveCredentials = {
  success: true,
  roomId: 'room-9001',
  userId: '1',
  userSig: 'sig',
  sdkAppId: 1400000000,
  wsUrl: 'wss://example.com/live',
  ackConfirmed: true,
  liveState: 'RUNNING',
}

const adminSession: AuthSession = {
  token: 't',
  user: { username: 'admin', displayName: '张监管', role: 'ADMIN', teamName: '平台' },
}

const cleanups: Array<() => void> = []

const mountView = async (component: typeof OrderDetailView | typeof SuperviseView, path: string) => {
  await router.push(path)
  const wrapper = mount(component, { global: { plugins: [router, ElementPlus] } })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return wrapper as VueWrapper
}

const clickTab = async (wrapper: VueWrapper, label: string) => {
  const tab = wrapper.findAll('.el-tabs__item').find((item) => item.text().includes(label))
  expect(tab, `未找到 Tab：${label}`).toBeTruthy()
  await tab!.trigger('click')
  await flushPromises()
}

const START_CONTROL_LABELS = ['开播', '拉起图传', '关闭会话', '停止直播', '航线规划']

const expectNoStartControls = (wrapper: VueWrapper) => {
  const labels = wrapper.findAll('button').map((button) => button.text())
  for (const label of START_CONTROL_LABELS) {
    expect(labels.some((text) => text.includes(label))).toBe(false)
  }
}

describe('订单详情双模式（TASK-FRONTEND-003）', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clearStoredSession()
    setStoredSession(adminSession)
    getAdminOrderDetail.mockResolvedValue(inactiveOrder)
    getAdminTaskDetail.mockResolvedValue(inactiveTask)
    fetchTaskLiveDetail.mockResolvedValue(null)
    fetchTaskApplications.mockResolvedValue(applicationsFixture)
    fetchTaskEvidence.mockResolvedValue(evidenceFixture)
    fetchOrderComplaints.mockResolvedValue([complaintFixture])
    getOrderTrajectory.mockResolvedValue(trajectoryFixture)
    getUavPosition.mockResolvedValue(trajectoryFixture.at(-1))
    getPullCredentials.mockResolvedValue(credentialsFixture)
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    clearStoredSession()
  })

  it('非执行中订单默认「订单管理」且不提供任务监管 Tab', async () => {
    const wrapper = await mountView(OrderDetailView, '/orders/ORD-A')

    const tabs = wrapper.findAll('.el-tabs__item').map((item) => item.text())
    expect(tabs).toContain('订单管理')
    expect(tabs).not.toContain('任务监管')

    expect(wrapper.text()).toContain('撮合时间线')
    expect(wrapper.text()).not.toContain('作业上下文')
  })

  it('执行中订单默认「任务监管」，可切回订单管理再切回监管', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(liveDetailFixture)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B')

    const tabs = wrapper.findAll('.el-tabs__item').map((item) => item.text())
    expect(tabs).toContain('任务监管')
    expect(tabs).toContain('订单管理')
    expect(wrapper.text()).toContain('作业上下文')
    expect(wrapper.text()).not.toContain('撮合时间线')

    await clickTab(wrapper, '订单管理')
    expect(wrapper.text()).toContain('撮合时间线')

    await clickTab(wrapper, '任务监管')
    expect(wrapper.text()).toContain('作业上下文')
  })

  it('?tab=manage 定位订单管理 Tab（全屏页「查看订单管理」落点）', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(liveDetailFixture)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B?tab=manage')

    expect(wrapper.text()).toContain('撮合时间线')
    expect(wrapper.text()).not.toContain('作业上下文')
  })

  it('订单管理 Tab 渲染时间线、只读计价、应征、证据与争议区块', async () => {
    const wrapper = await mountView(OrderDetailView, '/orders/ORD-A')

    expect(fetchTaskApplications).toHaveBeenCalledWith('T1')
    expect(fetchTaskEvidence).toHaveBeenCalledWith('T1')
    expect(fetchOrderComplaints).toHaveBeenCalledWith('ORD-A')

    const text = wrapper.text()
    // 时间线七节点
    for (const step of ['发布', '应征', '选定下单', '支付', '双确认', '执飞', '结案']) {
      expect(text).toContain(step)
    }
    // 计价只读 + 禁止改价口径
    expect(text).toContain('¥980.00')
    expect(text).toContain('禁止改价')
    // 应征：飞手 / 机型 / 系统报价 / 状态
    expect(text).toContain('张飞手')
    expect(text).toContain('DJI FlyCart 30（FC30）')
    expect(text).toContain('¥1200.00')
    expect(text).toContain('已选定')
    expect(text).toContain('应征中')
    // 证据
    expect(text).toContain('吊运前照片.jpg')
    expect(text).toContain('查看')
    // 争议（数据展示 + 005 挂载点注释不渲染）
    expect(text).toContain('待处理')
    expect(text).toContain('货品交付时有磕碰')
    // 关联主体链接
    expect(text).toContain('查看用户 王五')
    expect(text).toContain('查看飞手 李四')
    expectNoStartControls(wrapper)
  })

  it('任务监管 Tab 只读接入图传：仅拉流凭据，零开播/停播调用', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(liveDetailFixture)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B')

    expect(getPullCredentials).toHaveBeenCalledWith('DJI-9001', '')
    expect(requestStartLive).not.toHaveBeenCalled()
    expect(closeLive).not.toHaveBeenCalled()
    expect(watchLiveStop).not.toHaveBeenCalled()

    const text = wrapper.text()
    expect(text).toContain('只读观看 · 无开播控制')
    expect(text).toContain('DJI-9001')
    expect(text).toContain('遥测摘要')
    expect(wrapper.find('.trtc-stub').exists()).toBe(true)
    expect(getOrderTrajectory).toHaveBeenCalledWith('ORD-B')
    expectNoStartControls(wrapper)
  })

  it('作业设备三级回退：/task/detail 不可用时改用管理端任务的契约 deviceId', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue({ ...activeTask, deviceId: 'DJI-7777' })
    fetchTaskLiveDetail.mockResolvedValue(null)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B')

    expect(getPullCredentials).toHaveBeenCalledWith('DJI-7777', '')
    const text = wrapper.text()
    expect(text).toContain('DJI-7777')
    expect(text).not.toContain('该任务暂无作业设备')
    expectNoStartControls(wrapper)
  })

  it('作业设备三级回退：任务详情与任务 VO 都没有时取订单的契约 deviceId', async () => {
    getAdminOrderDetail.mockResolvedValue({ ...activeOrder, deviceId: 'DJI-5555' })
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(null)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B')

    expect(getPullCredentials).toHaveBeenCalledWith('DJI-5555', '')
    expect(wrapper.text()).toContain('DJI-5555')
  })

  it('任务无作业设备时图传区降级为提示，且不发起拉流', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(null)

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-B')

    expect(getPullCredentials).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('该任务暂无作业设备')
  })

  it('撮合时间线直接回显契约时间字段（paidAt / 双确认）', async () => {
    getAdminOrderDetail.mockResolvedValue({
      ...inactiveOrder,
      paidAt: '2026-09-26 11:00:00',
      userConfirmedAt: '2026-09-26 12:00:00',
      riderConfirmedAt: '2026-09-26 12:05:00',
    })

    const wrapper = await mountView(OrderDetailView, '/orders/ORD-A')

    const text = wrapper.text()
    expect(text).toContain('2026-09-26 11:00:00') // 支付节点时间来自 order.paidAt
    expect(text).toContain('2026-09-26 12:05:00') // 双确认节点取两次确认里最晚的一次
    expect(text).not.toContain('已双确认（确认时间后端未回显）')
  })

  it('全屏 /orders/:orderNum/supervise 渲染 SuperviseView：只读监看 + 信息面板可收起', async () => {
    getAdminOrderDetail.mockResolvedValue(activeOrder)
    getAdminTaskDetail.mockResolvedValue(activeTask)
    fetchTaskLiveDetail.mockResolvedValue(liveDetailFixture)

    await router.push('/orders/ORD-B/supervise')
    // 路由不再重定向回订单详情
    expect(router.currentRoute.value.name).toBe('order-supervise')

    const wrapper = await mountView(SuperviseView, '/orders/ORD-B/supervise')

    const text = wrapper.text()
    expect(text).toContain('#ORD-B')
    expect(text).toContain('作业上下文')
    expect(text).toContain('遥测摘要')
    expect(text).toContain('只读观看 · 无开播控制')
    expect(getPullCredentials).toHaveBeenCalledWith('DJI-9001', '')
    expect(requestStartLive).not.toHaveBeenCalled()
    expect(closeLive).not.toHaveBeenCalled()
    expectNoStartControls(wrapper)

    const collapse = wrapper
      .findAll('button')
      .find((button) => button.text().includes('收起信息面板'))
    expect(collapse).toBeTruthy()
    await collapse!.trigger('click')
    await flushPromises()

    expect(wrapper.text()).not.toContain('作业上下文')
    expect(wrapper.text()).toContain('展开信息面板')
  })
})
