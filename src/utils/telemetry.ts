import type { OrderGpsPoint } from '../types/admin'

/** 遥测摘要（轨迹首尾点推导；供首页飞行卡与任务监管面板共用） */
export interface TelemetrySummary {
  altitude?: number
  speed?: number
  battery?: number
  /** 最后上报点位经纬度（监管面板展示） */
  latitude?: number
  longitude?: number
  /** 最后上报时间戳（ms） */
  reportedAt?: number
  /** 轨迹首个点位时间戳（ms，用作已飞时长起点） */
  startedAt?: number
}

/**
 * 轨迹点 → 遥测摘要：按 timestamp 升序取首尾点（首点=起飞时间，尾点=当前遥测）。
 * 空轨迹返回 undefined，由调用方降级为「等待设备上报」。
 */
export const summarizeTrajectory = (points: OrderGpsPoint[]): TelemetrySummary | undefined => {
  if (points.length === 0) {
    return undefined
  }
  const sorted = [...points].sort((left, right) => (left.timestamp ?? 0) - (right.timestamp ?? 0))
  const first = sorted[0]
  const last = sorted[sorted.length - 1]
  if (!first || !last) {
    return undefined
  }
  return {
    altitude: last.altitude,
    speed: last.speed,
    battery: last.battery,
    latitude: last.latitude,
    longitude: last.longitude,
    reportedAt: last.timestamp,
    startedAt: first.timestamp,
  }
}

/**
 * 单点位置 → 遥测摘要（轮询 `/webUav/position` 用）。
 * 该接口只返回最新一点，没有起飞时间；startedAt 由调用方从首帧轨迹带进来，
 * 缺失时保持 undefined，面板显示「—」而不是伪造一个时长。
 */
export const summarizePosition = (
  point: OrderGpsPoint | null | undefined,
  startedAt?: number,
): TelemetrySummary | undefined => {
  if (!point) {
    return undefined
  }
  return {
    altitude: point.altitude,
    speed: point.speed,
    battery: point.battery,
    latitude: point.latitude,
    longitude: point.longitude,
    reportedAt: point.timestamp,
    startedAt,
  }
}
