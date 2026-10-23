import { apiGet } from '../contract'
import { BizError } from './order'
import { toLiveState } from '../../types/uav'
import type { BackendUavItem, UavDeviceStatus, UavItem, UavListResult } from '../../types/uav'
import type { OrderGpsPoint } from '../../types/admin'

const mapBackendUav = (item: BackendUavItem, isOnline: boolean): UavItem => {
  return {
    id: item.id ?? 0,
    uavName: item.uavName ?? '',
    deviceId: item.djiId,
    isOnline,
    controllerModel: item.controllerModel,
    isAvailable: item.isAvailable,
  }
}

const fetchUavList = async (onlyOnline: boolean): Promise<UavListResult> => {
  // 契约：GET /webUav/getUav → Result<List<UavVo>>
  const body = await apiGet('/webUav/getUav', { params: { onlineOnly: onlyOnline } })
  if (!body.success) {
    throw new BizError(body.errorCode || 'UAV_LIST_FAILED', body.message || '获取无人机列表失败')
  }

  // 列表数据在 Result.data 数组中；onlineOnly=true 时由后端过滤出在线设备。
  // 全量列表不含在线状态字段，调用方需结合在线列表（或 /webUav/status）判定 isOnline。
  const items = body.data ?? []
  return {
    success: true,
    list: items.map((item) => mapBackendUav(item, onlyOnline)),
  }
}

export const listOnlineUavs = async (): Promise<UavListResult> => fetchUavList(true)

export const listAllUavs = async (): Promise<UavListResult> => fetchUavList(false)

/** 单设备实时状态（GET /webUav/status）：补齐列表 VO 缺失的在线/直播状态 */
export const getUavStatus = async (deviceId: string): Promise<UavDeviceStatus> => {
  const body = await apiGet('/webUav/status', { params: { deviceId } })
  if (!body.success || !body.data) {
    throw new BizError(body.errorCode || 'UAV_STATUS_FAILED', body.message || '获取无人机状态失败')
  }

  return {
    ...body.data,
    liveState: toLiveState(body.data.liveState),
  }
}

/**
 * 订单飞行轨迹（GET /webUav/trajectory）：按订单号升序返回 GPS 点位。
 * 首页飞行卡的遥测摘要（高度/速度/电量/最后上报）即取自首尾点位。
 */
export const getOrderTrajectory = async (orderNum: string): Promise<OrderGpsPoint[]> => {
  const body = await apiGet('/webUav/trajectory', { params: { orderNum } })
  if (!body.success) {
    throw new BizError(body.errorCode || 'TRAJECTORY_FAILED', body.message || '获取飞行轨迹失败')
  }
  return body.data ?? []
}

/**
 * 单设备最新位置（GET /webUav/position）：内存实时数据优先，缺失时后端回落到 DB 最近记录。
 * 遥测轮询用它代替整条轨迹，避免每次拉全量点位。
 */
export const getUavPosition = async (deviceId: string): Promise<OrderGpsPoint | null> => {
  const body = await apiGet('/webUav/position', { params: { deviceId } })
  if (!body.success) {
    throw new BizError(body.errorCode || 'POSITION_FAILED', body.message || '获取无人机位置失败')
  }
  return body.data ?? null
}
