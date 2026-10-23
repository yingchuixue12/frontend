import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ElementPlus from 'element-plus'
import LiveStage from '../../src/components/order/LiveStage.vue'
import TelemetryPanel from '../../src/components/order/TelemetryPanel.vue'

const { getPullCredentials, fetchOrderTelemetry, fetchOrderPosition, fetchOrderStartedAt } = vi.hoisted(() => ({
  getPullCredentials: vi.fn(),
  fetchOrderTelemetry: vi.fn(),
  fetchOrderPosition: vi.fn(),
  fetchOrderStartedAt: vi.fn(),
}))
const { leaveLive } = vi.hoisted(() => ({ leaveLive: vi.fn() }))
vi.mock('../../src/api/modules/order-supervision', () => ({
  fetchOrderTelemetry,
  fetchOrderPosition,
  fetchOrderStartedAt,
}))
vi.mock('../../src/api/modules/live', () => ({ leaveLive, getPullCredentials }))
vi.mock('../../src/components/TrtcPlayer.vue', () => ({ default: {
  props: ['credentials'], template: '<div data-testid="player">{{ credentials.roomId }}</div>',
} }))
const deferred = <T,>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}
afterEach(async () => { await flushPromises(); vi.useRealTimers(); vi.resetAllMocks() })

describe('supervision request lifecycles', () => {
  it('does not play credentials returned by a previous device', async () => {
    const old = deferred<unknown>()
    getPullCredentials.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ roomId: 'room-B' })
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    await wrapper.setProps({ deviceId: 'B' })
    await flushPromises()
    old.resolve({ roomId: 'room-A' })
    await flushPromises()
    expect(wrapper.get('[data-testid="player"]').text()).toBe('room-B')
    wrapper.unmount()
  })

  it('leaves the previous device when switching, without stopping the stream', async () => {
    getPullCredentials.mockResolvedValue({ roomId: 'room-A', liveState: 'RUNNING' })
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    await flushPromises()
    expect(leaveLive).not.toHaveBeenCalled()

    getPullCredentials.mockResolvedValue({ roomId: 'room-B', liveState: 'RUNNING' })
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
    getPullCredentials.mockReturnValueOnce(pending.promise)
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    wrapper.unmount()
    pending.resolve({ roomId: 'room-A' })
    await flushPromises()
    expect(leaveLive).toHaveBeenCalledWith('A')
  })

  it('shows the live state from pull credentials instead of /task/detail', async () => {
    getPullCredentials.mockResolvedValue({ roomId: 'room-A', liveState: 'RUNNING' })
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
    expect(fetchOrderTelemetry).toHaveBeenCalledTimes(1)
    expect(fetchOrderStartedAt).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('replaces an in-flight position when the same order changes devices', async () => {
    const old = deferred<unknown>()
    fetchOrderStartedAt.mockResolvedValue(1_000)
    fetchOrderPosition.mockReturnValueOnce(old.promise).mockResolvedValue({ altitude: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' }, global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    await wrapper.setProps({ deviceId: 'D2' })
    await flushPromises()
    old.resolve({ altitude: 10 })
    await flushPromises()
    expect(fetchOrderPosition).toHaveBeenCalledWith('D2', 1_000)
    expect(wrapper.text()).toContain('80.0 m')
    expect(wrapper.text()).not.toContain('10.0 m')
    wrapper.unmount()
  })

  it('does not let a late trajectory overwrite the next order start time', async () => {
    const old = deferred<number>()
    fetchOrderStartedAt.mockReturnValueOnce(old.promise).mockResolvedValueOnce(9_000)
    fetchOrderPosition.mockResolvedValue({ altitude: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' }, global: { plugins: [ElementPlus] },
    })
    await wrapper.setProps({ orderNum: 'B', deviceId: 'D2' })
    await flushPromises()
    old.resolve(1_000)
    await flushPromises()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(fetchOrderPosition).toHaveBeenLastCalledWith('D2', 9_000)
    wrapper.unmount()
  })

  it('retries an empty start time and stops after three attempts', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    fetchOrderStartedAt.mockResolvedValue(null)
    fetchOrderPosition.mockResolvedValue({ altitude: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' }, global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchOrderStartedAt).toHaveBeenCalledTimes(3)
    expect(fetchOrderPosition).toHaveBeenCalledTimes(7)
    wrapper.unmount()
  })

  it('recovers the start time after an initially empty trajectory', async () => {
    fetchOrderStartedAt.mockResolvedValueOnce(null).mockResolvedValueOnce(9_000)
    fetchOrderPosition.mockResolvedValue({ altitude: 80 })
    const wrapper = mount(TelemetryPanel, {
      props: { orderNum: 'A', deviceId: 'D1' }, global: { plugins: [ElementPlus] },
    })
    await flushPromises()
    await wrapper.find('button').trigger('click')
    await flushPromises()
    expect(fetchOrderPosition).toHaveBeenLastCalledWith('D1', 9_000)
    wrapper.unmount()
  })

  it('finishes the old A watch before acquiring a new A watch', async () => {
    const old = deferred<unknown>()
    const operations: string[] = []
    getPullCredentials.mockImplementationOnce(() => old.promise)
      .mockImplementation(async (device: string) => {
        operations.push(`get:${device}`)
        return { roomId: `room-${device}` }
      })
    leaveLive.mockImplementation(async (device: string) => { operations.push(`leave:${device}`) })
    const wrapper = mount(LiveStage, { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } })
    await flushPromises()
    await wrapper.setProps({ deviceId: 'B' })
    await flushPromises()
    await wrapper.setProps({ deviceId: 'A' })
    await flushPromises()
    expect(getPullCredentials).toHaveBeenCalledTimes(2)
    old.resolve({ roomId: 'room-A-old' })
    await flushPromises()
    expect(operations.filter((item) => item.endsWith(':A'))).toEqual(['leave:A', 'get:A'])
    expect(wrapper.get('[data-testid="player"]').text()).toBe('room-A')
    wrapper.unmount()
  })

  it('waits for the previous mount to leave before reacquiring the same device', async () => {
    const leaving = deferred<void>()
    getPullCredentials.mockResolvedValue({ roomId: 'room-A' })
    leaveLive.mockReturnValueOnce(leaving.promise)
    const options = { props: { deviceId: 'A' }, global: { plugins: [ElementPlus] } }
    const first = mount(LiveStage, options)
    await flushPromises()
    first.unmount()
    const second = mount(LiveStage, options)
    await flushPromises()
    expect(leaveLive).toHaveBeenCalledWith('A')
    expect(getPullCredentials).toHaveBeenCalledTimes(1)
    leaving.resolve()
    await flushPromises()
    expect(getPullCredentials).toHaveBeenCalledTimes(2)
    expect(second.get('[data-testid="player"]').text()).toBe('room-A')
    second.unmount()
  })
})
