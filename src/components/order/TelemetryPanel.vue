<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import {
  fetchOrderPosition,
  fetchOrderStartedAt,
  fetchOrderTelemetry,
} from '../../api/modules/order-supervision'
import type { TelemetrySummary } from '../../utils/telemetry'
import { formatClock, formatDuration } from '../../utils/date'

/**
 * 遥测摘要面板（任务监管 Tab / 全屏监管共用）：
 * 轮询 `/webUav/position?deviceId=`（单点实时位置，10 秒一次，卸载即停）；
 * 起飞时间读取 `/webUav/trajectory?orderNum=` 的首点后缓存；空结果最多尝试三次。
 * 无作业设备（null）时不轮询，只取一次订单轨迹摘要兜底；两者都无数据才提示无遥测。
 */
const props = defineProps<{
  orderNum: string
  /** 作业设备；undefined = 解析中，null = 该任务无作业设备 */
  deviceId?: string | null
}>()

const TELEMETRY_POLL_MS = 10_000
const STARTED_AT_MAX_TRIES = 3

const telemetry = ref<TelemetrySummary | null>()
const loading = ref(false)

let requestSeq = 0
let disposed = false
let inFlightKey = ''
/** 只缓存成功取得的起飞时间；空结果在后续刷新时重试，总计最多三次。 */
const startedAtByOrder = new Map<string, number>()
const startedAtTries = new Map<string, number>()

const refresh = async () => {
  const orderNum = props.orderNum
  const deviceId = props.deviceId
  const requestKey = `${orderNum}\u0000${deviceId ?? 'pending'}`
  if (disposed || (inFlightKey === requestKey && loading.value)) return
  const seq = ++requestSeq
  if (!orderNum) { telemetry.value = null; loading.value = false; return }
  if (deviceId === undefined) {
    // 设备解析中：不清空已有数据，等 deviceId 落定后再取
    loading.value = false
    return
  }
  inFlightKey = requestKey
  loading.value = true
  try {
    if (!deviceId) {
      const result = await fetchOrderTelemetry(orderNum)
      if (!disposed && seq === requestSeq) telemetry.value = result ?? null
      return
    }
    let startedAt = startedAtByOrder.get(orderNum)
    const tries = startedAtTries.get(orderNum) ?? 0
    if (startedAt === undefined && tries < STARTED_AT_MAX_TRIES) {
      startedAtTries.set(orderNum, tries + 1)
      const fetchedStartedAt = await fetchOrderStartedAt(orderNum)
      if (disposed || seq !== requestSeq) return
      if (fetchedStartedAt != null) {
        startedAtByOrder.set(orderNum, fetchedStartedAt)
        startedAt = fetchedStartedAt
      }
    }
    const result = await fetchOrderPosition(deviceId, startedAt)
    if (!disposed && seq === requestSeq) telemetry.value = result ?? null
  } finally {
    if (!disposed && seq === requestSeq) { loading.value = false; inFlightKey = '' }
  }
}

const metrics = computed(() => {
  const data = telemetry.value
  return [
    { label: '高度', value: data?.altitude != null ? `${data.altitude.toFixed(1)} m` : '—' },
    { label: '速度', value: data?.speed != null ? `${data.speed.toFixed(1)} m/s` : '—' },
    { label: '电量', value: data?.battery != null ? `${data.battery}%` : '—' },
    {
      label: '经纬度',
      value:
        data?.latitude != null && data?.longitude != null
          ? `${data.latitude.toFixed(5)}, ${data.longitude.toFixed(5)}`
          : '—',
    },
    {
      label: '已飞时长',
      value:
        data?.startedAt != null && data?.reportedAt != null
          ? formatDuration(Math.max(0, data.reportedAt - data.startedAt))
          : '—',
    },
    {
      label: '最后上报',
      value: data?.reportedAt != null ? formatClock(new Date(data.reportedAt)) : '—',
    },
  ]
})

const empty = computed(() => !loading.value && telemetry.value === null)
const noDevice = computed(() => props.deviceId === null || props.deviceId === '')

let pollTimer: ReturnType<typeof setInterval> | undefined
const stopPolling = () => {
  if (pollTimer !== undefined) {
    clearInterval(pollTimer)
    pollTimer = undefined
  }
}

watch(
  () => [props.orderNum, props.deviceId] as const,
  async ([, deviceId], _old, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
      requestSeq += 1
      inFlightKey = ''
      loading.value = false
      stopPolling()
    })
    stopPolling()
    telemetry.value = undefined
    if (deviceId === undefined) return
    await refresh()
    if (active && !disposed && props.orderNum && deviceId) {
      pollTimer = setInterval(() => {
        void refresh()
      }, TELEMETRY_POLL_MS)
    }
  },
  { immediate: true },
)

onBeforeUnmount(() => { disposed = true; requestSeq += 1; stopPolling() })
</script>

<template>
  <section class="panel-card p-4" v-loading="loading">
    <div class="flex items-center justify-between">
      <div class="panel-title">遥测摘要</div>
      <el-button size="small" :loading="loading" @click="refresh">刷新</el-button>
    </div>

    <div v-if="empty && noDevice" class="empty-note">该任务暂无作业设备，无可读取的实时遥测</div>
    <div v-else-if="empty" class="empty-note">遥测暂无数据（等待设备上报）</div>

    <div v-else class="metric-grid mt-3">
      <div v-for="item in metrics" :key="item.label" class="metric-cell">
        <span>{{ item.label }}</span>
        <strong>{{ item.value }}</strong>
      </div>
    </div>
  </section>
</template>

<style scoped>
.panel-title {
  font-size: 1rem;
  font-weight: 800;
  color: var(--text-strong);
}

.empty-note {
  margin-top: 0.75rem;
  padding: 1rem;
  border: 1px dashed var(--border);
  border-radius: 10px;
  background: var(--bg-sunken);
  color: var(--text-secondary);
  font-size: 0.9rem;
}

.metric-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 0.6rem;
}

.metric-cell {
  padding: 0.7rem 0.8rem;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-sunken);
}

.metric-cell span {
  display: block;
  font-size: 0.78rem;
  color: var(--text-secondary);
}

.metric-cell strong {
  display: block;
  margin-top: 0.3rem;
  font-family: 'Fira Code', monospace;
  font-size: 0.98rem;
  color: var(--text-strong);
}
</style>
