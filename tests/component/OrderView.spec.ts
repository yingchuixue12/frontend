import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createMemoryHistory, createRouter } from 'vue-router'
import ElementPlus from 'element-plus'
import OrderView from '../../src/views/OrderView.vue'
import type { AdminOrderVo, AdminTaskVo } from '../../src/types/admin'

const { getAdminOrders, getAdminTasks, getAdminOrderDetail, getAdminTaskDetail } = vi.hoisted(() => ({
  getAdminOrders: vi.fn(),
  getAdminTasks: vi.fn(),
  getAdminOrderDetail: vi.fn(),
  getAdminTaskDetail: vi.fn(),
}))

// 只 mock 查询函数，状态映射（C5）走真实实现
vi.mock('../../src/api/modules/admin-query', async () => {
  const actual = (await vi.importActual('../../src/api/modules/admin-query')) as Record<string, unknown>
  return {
    ...actual,
    getAdminOrders,
    getAdminTasks,
    getAdminOrderDetail,
    getAdminTaskDetail,
  }
})

const orderFixture = (overrides: Partial<AdminOrderVo> = {}): AdminOrderVo => ({
  orderNum: 'ORD-001',
  userId: 1,
  ownerName: '运营管理员',
  taskNum: 'TASK-001',
  taskName: '巡检任务',
  totalAmount: 12.5,
  totalDistance: 250,
  orderStatusCode: 4,
  orderStatus: 'COMPLETED',
  orderStatusDesc: '已完成',
  createTime: '2026-09-12 10:00:00',
  updateTime: '2026-09-12 11:00:00',
  ...overrides,
})

const taskFixture = (overrides: Partial<AdminTaskVo> = {}): AdminTaskVo => ({
  id: 1,
  taskNum: 'TASK-001',
  taskName: '巡检任务',
  userId: 1,
  ownerName: '运营管理员',
  taskStatus: 'COMPLETED',
  taskStatusDesc: '执行完毕',
  taskTime: '2026-09-12 10:00:00',
  reward: 12.5,
  description: '园区巡检',
  orderNum: 'ORD-001',
  orderStatusCode: 4,
  orderStatus: 'COMPLETED',
  orderStatusDesc: '已完成',
  totalAmount: 12.5,
  totalDistance: 250,
  riderName: '飞手张三',
  completeNote: '已按航线完成',
  actionHint: '等待用户验收',
  createTime: '2026-09-12 09:00:00',
  updateTime: '2026-09-12 11:00:00',
  ...overrides,
})

const pageOf = <T,>(content: T[]) => ({
  content,
  page: 0,
  size: 10,
  totalElements: content.length,
  totalPages: 1,
})

const mounted: Array<ReturnType<typeof mount>> = []
const mountView = async (query: Record<string, string> = {}) => {
  const router = createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/', name: 'dashboard', component: { template: '<div />' } }],
  })
  await router.push({ path: '/', query })
  await router.isReady()
  const wrapper = mount(OrderView, {
    // Navigation is covered by MainLayout tests; retain real tabs, tables and drawers here.
    global: { plugins: [router, ElementPlus], stubs: { MainLayout: { template: '<div><slot /></div>' } } },
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

describe('OrderView 任务/订单管理视图（1B-5b）', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    getAdminOrders.mockResolvedValue(
      pageOf([
        orderFixture(),
        orderFixture({
          orderNum: 'ORD-002',
          taskNum: 'TASK-002',
          taskName: '测绘任务',
          orderStatusCode: 5,
          orderStatus: 'WAITING_CONFIRM',
          orderStatusDesc: '待验收',
        }),
      ]),
    )
    getAdminTasks.mockResolvedValue(pageOf([taskFixture()]))
  })

  afterEach(async () => {
    for (const wrapper of mounted.splice(0)) wrapper.unmount()
    await flushPromises()
  })

  it('默认加载订单分页（page 0 起）并渲染 C5 状态映射 4/5', async () => {
    const wrapper = await mountView()

    expect(getAdminOrders).toHaveBeenCalledWith({
      page: 0,
      size: 10,
      status: undefined,
      orderNum: undefined,
      taskNum: undefined,
    })

    const text = wrapper.text()
    expect(text).toContain('ORD-001')
    expect(text).toContain('巡检任务')
    expect(text).toContain('运营管理员')
    expect(text).toContain('已完成') // orderStatusCode=4（C5 补全）
    expect(text).toContain('待验收') // orderStatusCode=5（C5 补全）
  })

  it('订单详情抽屉：调 /admin/orders/{orderNum} 并渲染金额字段', async () => {
    getAdminOrderDetail.mockResolvedValue(orderFixture({ totalAmount: 33.3 }))
    const wrapper = await mountView()

    const detailButton = wrapper.findAll('button').find((button) => button.text().includes('详情'))
    await detailButton!.trigger('click')
    await flushPromises()

    expect(getAdminOrderDetail).toHaveBeenCalledWith('ORD-001')
    expect(wrapper.text()).toContain('¥33.30')
  })

  it('订单号关键字走服务端精确过滤，不再扫描候选集', async () => {
    const orderNum = 'MO2026102212000012345678901'
    getAdminOrders.mockResolvedValue(pageOf([orderFixture({ orderNum })]))
    const wrapper = await mountView({ q: orderNum })

    // 精确过滤 = 基础分页模式：首次请求即带上 orderNum，且没有第二页扫描
    expect(getAdminOrders).toHaveBeenCalledWith({
      page: 0,
      size: 10,
      status: undefined,
      orderNum,
      taskNum: undefined,
    })
    expect(wrapper.text()).toContain(orderNum)
  })

  it('任务号关键字走服务端精确过滤', async () => {
    const taskNum = 'RT2026102212000012345678901'
    getAdminTasks.mockResolvedValue(pageOf([taskFixture({ taskNum })]))
    await mountView({ q: taskNum })

    const orderCall = getAdminOrders.mock.calls[0][0]
    expect(orderCall).toMatchObject({ page: 0, size: 10, taskNum, orderNum: undefined })
    // 飞行中置顶所需的 in-progress 任务扫描同样下推 taskNum
    expect(getAdminTasks).toHaveBeenCalledWith({
      page: 0,
      size: 100,
      status: 'IN_PROGRESS',
      taskNum,
    })
  })

  it('飞行中筛选 + 订单号：先由订单详情取任务号，再精确查任务（不扫描）', async () => {
    const orderNum = 'MO2026102212000012345678901'
    const taskNum = 'RT2026102212000012345678901'
    getAdminOrderDetail.mockResolvedValue(orderFixture({ orderNum, taskNum }))
    getAdminTasks.mockResolvedValue(pageOf([taskFixture({ taskNum, taskStatus: 'IN_PROGRESS' })]))

    const wrapper = await mountView({ q: orderNum, status: 'in_progress' })

    expect(getAdminOrderDetail).toHaveBeenCalledWith(orderNum)
    expect(getAdminTasks).toHaveBeenCalledWith({
      page: 0,
      size: 100,
      status: 'IN_PROGRESS',
      taskNum,
    })
    expect(getAdminOrders).not.toHaveBeenCalled()
    // 列表以任务为行源（订单号列取任务的 orderNum），验证命中而非空态
    expect(wrapper.text()).toContain('巡检任务')
    expect(wrapper.text()).not.toContain('暂无订单数据')
  })

  it('飞行中筛选 + 订单号查不到关联任务时展示空结果', async () => {
    const orderNum = 'MO2026102212000012345678901'
    getAdminOrderDetail.mockRejectedValue(new Error('订单不存在'))

    const wrapper = await mountView({ q: orderNum, status: 'in_progress' })

    expect(getAdminTasks).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('暂无订单数据')
  })

  it('切换任务管理 tab 懒加载 /admin/tasks 并渲染任务状态与飞手', async () => {
    const wrapper = await mountView()

    const tabItems = wrapper.findAll('.el-tabs__item')
    await tabItems.find((item) => item.text().includes('任务管理'))!.trigger('click')
    await flushPromises()

    expect(getAdminTasks).toHaveBeenCalledWith({
      page: 0,
      size: 10,
      status: undefined,
      taskNum: undefined,
    })

    const text = wrapper.text()
    expect(text).toContain('TASK-001')
    expect(text).toContain('飞手张三')
    expect(text).toContain('执行完毕')
  })

  it('任务详情抽屉：调 /admin/tasks/{taskNum} 并渲染说明与完成信息', async () => {
    getAdminTaskDetail.mockResolvedValue(taskFixture())
    const wrapper = await mountView()

    const tabItems = wrapper.findAll('.el-tabs__item')
    await tabItems.find((item) => item.text().includes('任务管理'))!.trigger('click')
    await flushPromises()

    const detailButtons = wrapper.findAll('button').filter((button) => button.text().includes('详情'))
    await detailButtons[detailButtons.length - 1].trigger('click')
    await flushPromises()

    expect(getAdminTaskDetail).toHaveBeenCalledWith('TASK-001')
    const text = wrapper.text()
    expect(text).toContain('园区巡检')
    expect(text).toContain('已按航线完成')
    expect(text).toContain('等待用户验收')
  })
})
