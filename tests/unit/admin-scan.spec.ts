import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildTaskIndex,
  classifyAdminKeyword,
  fetchPendingComplaints,
  scanInProgressTasks,
  scanOrders,
} from '../../src/api/modules/admin-scan'

const { getAdminOrders, getAdminTasks, getAdminComplaints } = vi.hoisted(() => ({
  getAdminOrders: vi.fn(), getAdminTasks: vi.fn(), getAdminComplaints: vi.fn(),
}))
vi.mock('../../src/api/modules/admin-query', () => ({ getAdminOrders, getAdminTasks, getAdminComplaints }))

describe('bounded admin scans', () => {
  beforeEach(() => vi.resetAllMocks())

  it('preserves truncation for task lists and task indexes', async () => {
    getAdminTasks.mockImplementation(async ({ page }) => ({
      content: Array.from({ length: 100 }, (_, i) => ({ taskNum: `T-${page * 100 + i}` })), totalElements: 1200,
    }))
    expect(await scanInProgressTasks()).toMatchObject({ truncated: true, totalElements: 1200 })
    const result = await buildTaskIndex()
    expect(result.truncated).toBe(true)
    expect(result.index.size).toBe(500)
  })

  it('reads pending complaints beyond the first page', async () => {
    getAdminComplaints.mockImplementation(async ({ page }) => ({
      complaints: page === 0 ? [{ id: 1 }, { id: 2 }] : [{ id: 3 }], totalElements: 3, totalPages: 2,
    }))
    expect(await fetchPendingComplaints(2)).toEqual({ rows: [{ id: 1 }, { id: 2 }, { id: 3 }], truncated: false })
  })

  it('reports incomplete complaint scans at the cap', async () => {
    getAdminComplaints.mockResolvedValue({ complaints: [{ id: 1 }], totalElements: 20, totalPages: 20 })
    expect((await fetchPendingComplaints(1)).truncated).toBe(true)
    expect(getAdminComplaints).toHaveBeenCalledTimes(10)
  })

  it('stops at the date boundary without reporting truncation', async () => {
    getAdminOrders.mockResolvedValue({ content: [
      { createTime: '2026-10-02 10:00:00' }, { createTime: '2026-10-01 10:00:00' },
    ], totalElements: 100 })
    const result = await scanOrders({ cutoff: '2026-10-02 00:00:00', pageSize: 2 })
    expect(result.rows).toHaveLength(1)
    expect(result.truncated).toBe(false)
    expect(getAdminOrders).toHaveBeenCalledTimes(1)
  })

  it('classifies full order/task numbers and pushes them to the server filters', async () => {
    const orderNum = 'MO2026102212000012345678901'
    const taskNum = 'RT2026102212000012345678901'
    expect(classifyAdminKeyword(` ${orderNum.toLowerCase()} `)).toEqual({ kind: 'orderNum', value: orderNum })
    expect(classifyAdminKeyword(taskNum)).toEqual({ kind: 'taskNum', value: taskNum })
    // 半截编号/人名继续走模糊扫描，避免输入过程中被精确匹配成空结果
    expect(classifyAdminKeyword('MO20261022')).toEqual({ kind: 'text', value: 'mo20261022' })
    expect(classifyAdminKeyword(' 张三 ')).toEqual({ kind: 'text', value: '张三' })
    expect(classifyAdminKeyword('')).toEqual({ kind: 'text', value: '' })

    getAdminOrders.mockResolvedValue({ content: [{ orderNum }], totalElements: 1 })
    await scanOrders({ orderNum })
    expect(getAdminOrders).toHaveBeenCalledWith({
      page: 0, size: 100, status: undefined, orderNum, taskNum: undefined,
    })

    getAdminTasks.mockResolvedValue({ content: [], totalElements: 0 })
    await scanInProgressTasks({ taskNum })
    expect(getAdminTasks).toHaveBeenCalledWith({
      page: 0, size: 100, status: 'IN_PROGRESS', taskNum,
    })
  })
})
