<script setup lang="ts">
import { computed, defineAsyncComponent, ref, watch } from 'vue'
const TrtcPlayer = defineAsyncComponent(() => import('../TrtcPlayer.vue').then((module) => module.default))
import { createLiveWatch } from '../../api/modules/live-watch'
import type { TaskProgressive } from '../../api/modules/order-supervision'
import type { LiveCredentials } from '../../types/uav'

/**
 * 图传只读接入（ADR-0004：监管是旁听）。
 * 只调用 `/live/get` 拉流凭据，**不调用** requestStartLive / closeLive —— 页面上没有任何
 * 开播/停播控件；设备离线或未开播时降级为提示，不会代监管员发起图传。
 * 离开（切换设备 / 卸载）对**旧**设备调 `/live/leave` 收口本人观看记录：`/live/get` 会开记录，
 * 不收口就会留下永不结束的观看会话；leave 不动推流，区别于 close。
 */
const props = defineProps<{
  /** `/task/detail` 回显（平台直播态展示用）；null = 不可用（无权或未回显） */
  liveDetail?: TaskProgressive | null
  /**
   * 作业设备：useOrderDetail 按 任务详情 → 管理端任务 → 订单 三级回退后的契约 deviceId。
   * undefined = 上游仍在解析；null = 解析完成但该任务无作业设备。
   */
  deviceId?: string | null
}>()

const emit = defineEmits<{ (e: 'live-state', value: string | undefined): void }>()

const stage = ref<'resolving' | 'ready' | 'waiting'>('resolving')
const note = ref('')
const credentials = ref<LiveCredentials | null>(null)

/** 平台直播态：拉流凭证是后端 `LiveSessionSnapshot` 的实时值，优先于 `/task/detail` 回显（管理员该接口 403） */
const liveState = computed(() => credentials.value?.liveState ?? props.liveDetail?.liveState)

const onPlayerError = (message: string) => {
  note.value = message
}

watch(
  () => props.deviceId,
  async (deviceId, _previous, onCleanup) => {
    let active = true
    onCleanup(() => { active = false })
    credentials.value = null
    if (deviceId === undefined) {
      stage.value = 'resolving'
      note.value = ''
      return
    }

    if (!deviceId) {
      stage.value = 'waiting'
      note.value = '该任务暂无作业设备（未接单 / 飞手未绑定设备 / 设备离线），暂无可观看图传'
      return
    }

    stage.value = 'resolving'
    note.value = ''
    const watching = createLiveWatch(deviceId)
    onCleanup(() => { active = false; watching.release() })
    const pulled = await watching.credentials.catch((err: unknown) => {
      console.warn('[LiveStage] 拉流凭证不可用：', err)
      return null
    })
    if (!active) return
    if (!pulled) {
      stage.value = 'waiting'
      note.value = '图传未就绪：设备离线或未开播（只读接入，不会下发开播命令）'
      return
    }
    credentials.value = pulled
    stage.value = 'ready'
  },
  { immediate: true },
)

/** 上游（全屏监管的上下文面板）需要同一个直播态来源，避免自己再去读 403 的 /task/detail */
watch(
  liveState,
  (value) => emit('live-state', value),
  { immediate: true },
)
</script>

<template>
  <div class="live-stage">
    <div class="live-frame">
      <div v-if="stage === 'resolving'" class="live-placeholder">正在解析作业设备…</div>
      <div v-else-if="stage === 'waiting'" class="live-placeholder waiting">{{ note }}</div>
      <div v-else class="operation-video-shell">
        <TrtcPlayer :credentials="credentials" @error="onPlayerError" />
      </div>
    </div>

    <div class="live-meta">
      <el-tag size="small" type="info" effect="plain">只读观看 · 无开播控制</el-tag>
      <el-tag size="small" effect="plain">设备 {{ deviceId || '—' }}</el-tag>
      <el-tag size="small" effect="plain">平台直播态 {{ liveState || '—' }}</el-tag>
    </div>
  </div>
</template>

<style scoped>
.live-stage {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.live-frame {
  display: flex;
  justify-content: center;
}

.operation-video-shell {
  position: relative;
  width: 100%;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid #111827;
  background: #020617;
  aspect-ratio: 16 / 9;
  min-height: clamp(240px, 38vh, 460px);
}

.live-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  min-height: clamp(240px, 38vh, 460px);
  padding: 1.5rem;
  border-radius: 16px;
  border: 1px dashed var(--border);
  background: var(--bg-sunken);
  color: var(--text-secondary);
  font-size: 0.95rem;
  text-align: center;
}

.live-placeholder.waiting {
  border-color: #fde2e2;
  background: var(--danger-soft);
  color: #f56c6c;
}

.live-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}
</style>
