import { getPullCredentials, leaveLive } from './live'

// 同一设备的获取/退出按发起顺序执行，防止旧 leave 晚于新 get 而结束新观看记录。
const pendingByDevice = new Map<string, Promise<unknown>>()

const enqueue = <T>(deviceId: string, operation: () => Promise<T>): Promise<T> => {
  const previous = pendingByDevice.get(deviceId) ?? Promise.resolve()
  const pending = previous.catch(() => undefined).then(operation)
  pendingByDevice.set(deviceId, pending)
  void pending.finally(() => {
    if (pendingByDevice.get(deviceId) === pending) pendingByDevice.delete(deviceId)
  }).catch(() => undefined)
  return pending
}

/** 页面一开始请求即持有租约；退出可以在凭证返回前登记，并排在下次进入之前。 */
export const createLiveWatch = (deviceId: string) => {
  let acquired = false
  let released = false
  const credentials = enqueue(deviceId, async () => {
    const result = await getPullCredentials(deviceId, '')
    acquired = true
    return result
  })
  return {
    credentials,
    release: () => {
      if (released) return
      released = true
      void enqueue(deviceId, async () => {
        if (acquired) await leaveLive(deviceId)
      }).catch((err: unknown) => console.warn('[live-watch] 退出观看失败：', err))
    },
  }
}
