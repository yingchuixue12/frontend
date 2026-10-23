import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import HomeView from '../../src/views/HomeView.vue'
import router from '../../src/router'
import { clearStoredSession, setStoredSession } from '../../src/api/session'
import type { AuthSession } from '../../src/types/auth'
import type {
  AdminComplaint,
  AdminOrderVo,
  AdminTaskVo,
  OrderGpsPoint,
} from '../../src/types/admin'
import { formatDateTime } from '../../src/utils/date'

const { getAdminTasks, getAdminOrders, getAdminComplaints, getAdminPilots, getOrderTrajectory, getUavPosition } =
  vi.hoisted(() => ({
    getAdminTasks: vi.fn(),
    getAdminOrders: vi.fn(),
    getAdminComplaints: vi.fn(),
    getAdminPilots: vi.fn(),
    getOrderTrajectory: vi.fn(),
    getUavPosition: vi.fn(),
  }))

// 只 mock 查询函数；admin-scan 编排（分页扫描/cutoff）走真实实现
vi.mock('../../src/api/modules/admin-query', async () => {
  const actual = (await vi.importActual('../../src/api/modules/admin-query')) as Record<
    string,
    unknown
  >
  return { ...actual, getAdminTasks, getAdminOrders, getAdminComplaints, getAdminPilots }
})
vi.mock('../../src/api/modules/uav', () => ({ getOrderTrajectory, getUavPosition }))

const pageOf = <T,>(content: T[], totalElements = content.length) => ({
  content,
  page: 0,
  size: 100,
  totalElements,
  totalPages: 1,
})

const inProgressTask: AdminTaskVo = {
  id: 1,
  taskNum: 'TASK-F01',
  taskName: '工地吊运',
  userId: 1,
  ownerName: '王五',
  taskStatus: 'IN_PROGRESS',
  taskStatusDesc: '执行中',
  description: '工地A → 山顶B',
  orderNum: 'ORD-F01',
  orderStatusCode: 1,
  orderStatus: 'PAID',
  orderStatusDesc: '已支付',
  totalAmount: 980,
  totalDistance: 1250,
  riderName: '李四',
  deviceId: 'DJI-F01',
  createTime: formatDateTime(new Date()),
  updateTime: formatDateTime(new Date()),
}

const todayOrder = (orderNum: string): AdminOrderVo => ({
  orderNum,
  userId: 1,
  ownerName: '王五',
  taskNum: 'TASK-F01',
  taskName: '工地吊运',
  totalAmount: 100,
  totalDistance: 800,
  orderStatusCode: 0,
  orderStatus: 'PENDING',
  orderStatusDesc: '待支付',
  createTime: formatDateTime(new Date()),
  updateTime: formatDateTime(new Date()),
})

const twoDaysAgo = formatDateTime(new Date(Date.now() - 2 * 86_400_000))

const complaintFixture: AdminComplaint = {
  id: 7,
  orderNum: 'ORD-D01',
  status: 'PENDING',
  reason: 'QUALITY_ISSUE',
  description: '货物损坏',
  userId: 2,
  createTime: formatDateTime(new Date()),
}

const trajectoryFixture = (): OrderGpsPoint[] => {
  const now = Date.now()
  return [
    { altitude: 42, speed: 8.1, battery: 78, timestamp: now - 10 * 60_000 },
    { altitude: 45.5, speed: 7.2, battery: 75, timestamp: now },
  ]
}

const adminSession: AuthSession = {
  token: 't',
  user: { username: 'admin', displayName: '张监管', role: 'ADMIN', teamName: '平台' },
}

const cleanups: Array<() => void> = []

const mountHome = async () => {
  const wrapper = mount(HomeView, { global: { plugins: [router, ElementPlus] } })
  cleanups.push(() => wrapper.unmount())
  await flushPromises()
  return wrapper
}

describe('首页看板（TASK-FRONTEND-002）', () => {
  it('刷新失败展示错误且不伪造成功更新时间', async () => {
    getAdminTasks.mockRejectedValueOnce(new Error('网络中断'))
    const wrapper = await mountHome()
    expect(wrapper.text()).toContain('网络中断')
    expect(wrapper.text()).toContain('更新于 --:--:--')
    expect(wrapper.text()).not.toContain('当前无飞行作业')
  })

  it('今日订单达到扫描上限时显示下界与不完整提示', async () => {
    getAdminOrders.mockImplementation(async ({ status }: { status?: string }) => status === '5' ? pageOf([]) :
      { ...pageOf(Array.from({ length: 100 }, (_, i) => todayOrder(`O-${i}`)), 600), totalPages: 6 })
    const wrapper = await mountHome()
    expect(wrapper.get('[data-testid="metric-today"]').text()).toContain('至少 500')
    expect(wrapper.text()).toContain('部分数据未加载完整')
  })
  beforeEach(async () => {
    vi.clearAllMocks()
    clearStoredSession()
    setStoredSession(adminSession)
    await router.push('/')

    getAdminTasks.mockResolvedValue(pageOf([inProgressTask]))
    getAdminOrders.mockImplementation(async ({ status }: { status?: string }) =>
      status === '5'
        ? pageOf([todayOrder('ORD-W01'), { ...todayOrder('ORD-W02'), createTime: twoDaysAgo }], 3)
        : pageOf([todayOrder('ORD-T01'), todayOrder('ORD-T02')]),
    )
    getAdminComplaints.mockResolvedValue({
      complaints: [complaintFixture],
      currentPage: 0,
      totalElements: 3,
      totalPages: 1,
    })
    getAdminPilots.mockResolvedValue(pageOf([], 2))
    getOrderTrajectory.mockResolvedValue(trajectoryFixture())
    getUavPosition.mockResolvedValue(trajectoryFixture().at(-1))
  })

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) {
      cleanup()
    }
    vi.useRealTimers()
    clearStoredSession()
  })

  it('四指标卡渲染数值与更新时间戳', async () => {
    const w = await mountHome()

    expect(w.find('[data-testid="metric-flying"]').text()).toContain('1')
    expect(w.find('[data-testid="metric-today"]').text()).toContain('2')
    expect(w.find('[data-testid="metric-dispute"]').text()).toContain('3')
    expect(w.find('[data-testid="metric-pilot"]').text()).toContain('2')
    expect(w.text()).toContain('更新于')
  })

  it('指标卡点击带筛选跳转订单列表 / 飞手列表', async () => {
    const w = await mountHome()

    await w.find('[data-testid="metric-flying"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('orders'))
    expect(router.currentRoute.value.query).toEqual({ status: 'in_progress' })

    await router.push('/')
    await w.find('[data-testid="metric-dispute"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('orders'))
    expect(router.currentRoute.value.query).toEqual({ dispute: 'pending' })

    await router.push('/')
    await w.find('[data-testid="metric-pilot"]').trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('pilots'))
  })

  it('飞行表格渲染订单/主体/金额/遥测摘要与监管详情按钮', async () => {
    const w = await mountHome()

    const table = w.find('[data-testid="flying-table"]')
    expect(table.exists()).toBe(true)
    const text = table.text()
    expect(text).toContain('ORD-F01')
    expect(text).toContain('工地吊运')
    expect(text).toContain('王五')
    expect(text).toContain('李四')
    expect(text).toContain('¥980.00')
    expect(text).toContain('高度 45.5 m')
    expect(text).toContain('速度 7.2 m/s')
    expect(text).toContain('电量 75%')
    expect(text).toContain('已飞 10 分钟')

    const labels = table.findAll('button').map((button) => button.text())
    expect(labels.some((label) => label.includes('监管'))).toBe(true)
    expect(labels.some((label) => label.includes('详情'))).toBe(true)
  })

  it('飞行表格主体链接带定位参数跳实体列表（TASK-FRONTEND-004）', async () => {
    const w = await mountHome()
    const table = w.find('[data-testid="flying-table"]')

    const userLink = table.findAll('button').find((button) => button.text().includes('王五'))
    await userLink!.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('users'))
    expect(router.currentRoute.value.query).toEqual({ id: '1' })

    await router.push('/')
    const pilotLink = w
      .find('[data-testid="flying-table"]')
      .findAll('button')
      .find((button) => button.text().includes('李四'))
    await pilotLink!.trigger('click')
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('pilots'))
    expect(router.currentRoute.value.query).toEqual({ q: '李四' })
  })

  it('侧栏快捷入口、待办与今日新发 Top5', async () => {
    const w = await mountHome()

    const quickLabels = w.findAll('.quick-item').map((entry) => entry.text())
    expect(quickLabels).toEqual(
      expect.arrayContaining(['全部订单', '用户管理', '飞手管理', '系统日志']),
    )

    const todos = w.findAll('.todo')
    expect(todos).toHaveLength(2)
    expect(todos[0].text()).toContain('3 条待处理争议')
    expect(todos[0].text()).toContain('最新 ORD-D01 · 质量问题')
    expect(todos[1].text()).toContain('2 单创建超 24 小时且待验收')
    expect(todos[1].text()).toContain('ORD-W02')

    const top5 = w.findAll('[data-testid="today-table"] .el-table__row').map((row) => row.text())
    expect(top5[0]).toContain('ORD-T01')
    expect(top5[1]).toContain('ORD-T02')
    expect(w.text()).toContain('查看全部')
  })

  it('无飞行作业且无待办时展示空态并折叠待办', async () => {
    getAdminTasks.mockResolvedValue(pageOf([]))
    getAdminOrders.mockImplementation(
      async ({ status }: { status?: string }) => (status === '5' ? pageOf([], 0) : pageOf([])),
    )
    getAdminComplaints.mockResolvedValue({
      complaints: [],
      currentPage: 0,
      totalElements: 0,
      totalPages: 0,
    })
    getAdminPilots.mockResolvedValue(pageOf([], 0))

    const w = await mountHome()

    expect(w.text()).toContain('当前无飞行作业')
    expect(w.find('[data-testid="flying-table"]').exists()).toBe(false)
    expect(w.find('.todo').exists()).toBe(false)
    expect(w.text()).not.toContain('待办')
    expect(w.find('[data-testid="metric-flying"]').text()).toContain('0')
    expect(w.find('[data-testid="metric-pilot"]').text()).toContain('0')
    expect(getOrderTrajectory).not.toHaveBeenCalled()
  })

  it('飞行卡遥测每 10 秒轮询刷新，卸载后停止', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    // 本用例自行挂载并在中断言卸载，不走统一 cleanup（避免重复卸载）
    const local = mount(HomeView, { global: { plugins: [router, ElementPlus] } })
    await flushPromises()
    // 首帧：一次轨迹只为取起飞时间 + 一次位置取当前值
    expect(getOrderTrajectory).toHaveBeenCalledTimes(1)
    expect(getUavPosition).toHaveBeenCalledTimes(1)
    expect(getUavPosition).toHaveBeenCalledWith('DJI-F01')

    vi.advanceTimersByTime(10_000)
    await flushPromises()
    // 后续轮询只取单点，轨迹不再重复拉取
    expect(getOrderTrajectory).toHaveBeenCalledTimes(1)
    expect(getUavPosition).toHaveBeenCalledTimes(2)

    local.unmount()
    vi.advanceTimersByTime(30_000)
    await flushPromises()
    expect(getOrderTrajectory).toHaveBeenCalledTimes(1)
    expect(getUavPosition).toHaveBeenCalledTimes(2)
  })

  it('刚起飞轨迹为空时重试数次后停止拉整条轨迹', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    getOrderTrajectory.mockResolvedValue([])
    const local = mount(HomeView, { global: { plugins: [router, ElementPlus] } })
    await flushPromises()

    // 首帧 + 两次重试；轨迹始终为空，之后只轮询位置
    await vi.advanceTimersByTimeAsync(60_000)
    expect(getOrderTrajectory).toHaveBeenCalledTimes(3)
    expect(getUavPosition).toHaveBeenCalledTimes(7)
    local.unmount()
  })
})
