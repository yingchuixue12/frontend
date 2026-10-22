import { apiPost, expectData, expectSuccess } from '../contract'
import { BizError } from './order'
import { getUavStatus } from './uav'
import { toLiveState } from '../../types/uav'
import type { LiveCredentials, LiveStartResponse, UavDeviceStatus } from '../../types/uav'

export const requestStartLive = async (deviceId: string): Promise<LiveStartResponse> => {
  // 契约：POST /live/req?deviceId=… → Result<LiveStartVO>
  const body = await apiPost('/live/req', { params: { deviceId } })
  const data = expectData(body, '开播请求发送失败')

  return {
    success: true,
    code: data.code,
    message: data.code === 'LIVE_ALREADY_RUNNING' ? '图传已在运行中' : '开播请求已发送',
    roomId: data.roomId,
    requestId: data.requestId,
    ackConfirmed: data.ackConfirmed ?? false,
    liveState: toLiveState(data.liveState),
  }
}

export const getPullCredentials = async (
  deviceId: string,
  webUserId: string,
): Promise<LiveCredentials> => {
  // 契约：POST /live/get?deviceId=…&webUserId=… → Result<PullCredentialsVO>
  // webUserId 仅用于本地日志/占位；TRTC 身份由服务端从登录态生成（客户端不可指定）。
  void webUserId
  const body = await apiPost('/live/get', { params: { deviceId } })
  const data = expectData(body, '拉流凭证生成失败')

  return {
    success: true,
    roomId: data.roomId ?? '',
    userId: data.userId ?? '',
    userSig: data.userSig ?? '',
    sdkAppId: data.sdkAppId ?? 0,
    wsUrl: data.wsUrl,
    ackConfirmed: data.ackConfirmed ?? false,
    liveState: toLiveState(data.liveState),
  }
}

export interface LiveStopOutcome {
  /** 后端 200 分支文案：设备已确认停止推流 / 停止命令已发送，等待设备确认 / 无人机已离线，直播已结束 / 直播未在运行，观看记录已结束 */
  message: string
  /** false = 「等待设备确认」分支（STOP_LIVE ACK 超时），平台直播态需轮询 /webUav/status 收敛 */
  settled: boolean
}

export const closeLive = async (deviceId: string): Promise<LiveStopOutcome> => {
  // 契约：POST /live/close?deviceId=… → Result<Void>（data 恒为 null，靠 message 区分分支）
  const body = await apiPost('/live/close', { params: { deviceId } })
  if (!body.success) {
    // 409 LIVE_STOP_REJECTED（设备拒绝）/ 404 设备未注册等业务分支
    throw new BizError(body.errorCode || 'LIVE_STOP_FAILED', body.message || '结束观看失败')
  }

  // t12 协议：Result<Void>，data 恒为 null，200 各分支仅以 message 文案区分；
  // 「停止命令已发送，等待设备确认」= ACK 超时分支，后端靠设备 LIVE_STOPPED 事件兜底。
  const settled = !(body.message ?? '').includes('等待设备确认')
  return {
    message: body.message || '结束观看完成',
    settled,
  }
}

/**
 * POST /live/leave：退出观看（1B-4b 微端点）。
 * 仅结束当前登录用户在该设备的观看记录，不动推流与直播会话；幂等。
 * 用于监管页切换/离开设备——不得用 /live/close 代替，那会停掉整场推流。
 */
export const leaveLive = async (deviceId: string): Promise<void> => {
  const body = await apiPost('/live/leave', { params: { deviceId } })
  expectSuccess(body, '退出观看失败')
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 结束观看后收敛 UI：轮询单设备平台直播态，直到离开 RUNNING/STARTING（进入 IDLE）或次数用尽。
 * 用于 closeLive 的「等待设备确认」分支——后端等设备 LIVE_STOPPED 事件兜底，Web 端以 /webUav/status 为准。
 * 返回 true 表示已观测到终态；false 表示次数用尽或设备状态不可得。
 */
export const watchLiveStop = async (
  deviceId: string,
  onUpdate: (status: UavDeviceStatus) => void,
  options: { intervalMs?: number; maxAttempts?: number } = {},
): Promise<boolean> => {
  const intervalMs = options.intervalMs ?? 3000
  const maxAttempts = options.maxAttempts ?? 5

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await sleep(intervalMs)
    }

    let status: UavDeviceStatus
    try {
      status = await getUavStatus(deviceId)
    } catch {
      return false
    }

    onUpdate(status)

    if (!status.liveState || status.liveState === 'IDLE') {
      return true
    }
  }

  return false
}
