import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import LiveStage from '../../src/components/order/LiveStage.vue'
import TelemetryPanel from '../../src/components/order/TelemetryPanel.vue'

const { fetchWatchCredentials, fetchOrderTelemetry, fetchOrderPosition, fetchOrderStartedAt } = vi.hoisted(() => ({
  fetchWatchCredentials: vi.fn(),
  fetchOrderTelemetry: vi.fn(),
  fetchOrderPosition: vi.fn(),
  fetchOrderStartedAt: vi.fn(),
}))
const { leaveLive } = vi.hoisted(() => ({ leaveLive: vi.fn() }))
vi.mock('../../src/api/modules/order-supervision', () => ({
  fetchWatchCredentials,
  fetchOrderTelemetry,
  fetchOrderPosition,
  fetchOrderStartedAt,
}))
vi.mock('../../src/api/modules/live', () => ({ leaveLive }))
vi.mock('../../src/components/TrtcPlayer.vue', () => ({ default: {
  props: ['credentials'], template: '<div data-testid="player">{{ credentials.roomId }}</div>',
} }))
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(() => { vi.useRealTimers(); vi.resetAllMocks() })

describe('supervision request lifecycles', () => {
  it('does not play credentials returned by a previous device', async () => {
    const old = deferred<unknown>()
    fetchWatchCredentials.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ roomId: 'room-B' })
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    await wrapper.setProps({ deviceId: 'B' })
    await flushPromises()
    old.resolve({ roomId: 'room-A' })
    await flushPromises()
    expect(wrapper.get('[data-testid="player"]').text()).toBe('room-B')
    wrapper.unmount()
  })

  it('leaves the previous device when switching, without stopping the stream', async () => {
    fetchWatchCredentials.mockResolvedValue({ roomId: 'room-A', liveState: 'RUNNING' })
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(leaveLive).not.toHaveBeenCalled()

    fetchWatchCredentials.mockResolvedValue({ roomId: 'room-B', liveState: 'RUNNING' })
    await wrapper.setProps({ deviceId: 'B' })
    await flushPromises()

    expect(leaveLive).toHaveBeenCalledTimes(1)
    expect(leaveLive).toHaveBeenCalledWith('A')
    wrapper.unmount()
    await flushPromises()
    expect(leaveLive).toHaveBeenLastCalledWith('B')
  })

  it('closes the watch record even when credentials arrive after unmount', async () => {
    const pending = deferred<unknown>()
    fetchWatchCredentials.mockReturnValueOnce(pending.promise)
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    wrapper.unmount()
    pending.resolve({ roomId: 'room-A' })
    await flushPromises()
    expect(leaveLive).toHaveBeenCalledWith('A')
  })

  it('shows the live state from pull credentials instead of /task/detail', async () => {
    fetchWatchCredentials.mockResolvedValue({ roomId: 'room-A', liveState: 'RUNNING' })
    const wrapper = mount(LiveStage, {
      props: { deviceId: 'A', liveDetail: { taskNum: 'T1', liveState: 'IDLE' } },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(wrapper.text()).toContain('平台直播态 RUNNING')
    expect(wrapper.emitted('live-state')?.at(-1)).toEqual(['RUNNING'])
    wrapper.unmount()
  })

  it('discards old telemetry and does not start polling after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const old = deferred<unknown>()
    fetchOrderStartedAt.mockResolvedValue(undefined)
    fetchOrderPosition.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ altitude: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' },
      global: { plugins: [ElementPlus] },
    })
    await wrapper.setProps({ orderNum: 'B' })
    await flushPromises()
    expect(wrapper.text()).toContain('80.0 m')
    old.resolve({ altitude: 10 })
    await flushPromises()
    expect(wrapper.text()).not.toContain('10.0 m')
    wrapper.unmount()
    vi.advanceTimersByTime(30_000)
    expect(fetchOrderPosition).toHaveBeenCalledTimes(2)
  })

  it('does not leave a polling timer when initial load finishes after unmount', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const pending = deferred<null>()
    fetchOrderStartedAt.mockResolvedValue(undefined)
    fetchOrderPosition.mockReturnValue(pending.promise)
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    expect(fetchOrderPosition).toHaveBeenCalledTimes(1)
    wrapper.unmount()
    pending.resolve(null)
    await flushPromises()
    vi.advanceTimersByTime(30_000)
    expect(fetchOrderPosition).toHaveBeenCalledTimes(1)
  })

  it('polls one position point and reuses the trajectory start time', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    fetchOrderStartedAt.mockResolvedValue(1_000)
    fetchOrderPosition.mockResolvedValue({ altitude: 55, speed: 3, battery: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()

    expect(fetchOrderStartedAt).toHaveBeenCalledWith('A')
    expect(fetchOrderPosition).toHaveBeenCalledWith('D1', 1_000)
    expect(fetchOrderTelemetry).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(10_000)
    // 起飞时间只取一次，后续帧直接复用
    expect(fetchOrderStartedAt).toHaveBeenCalledTimes(1)
    expect(fetchOrderPosition).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('falls back to the order trajectory when the task has no device', async () => {
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: null },
      global: { plugins: [ElementPlus] },
    })
    await flushPromises()

    expect(fetchOrderPosition).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('该任务暂无作业设备')
  })
})
