<script setup lang="ts">
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import type { RouteLocationRaw } from 'vue-router'
import LiveStage from './LiveStage.vue'
import TelemetryPanel from './TelemetryPanel.vue'
import { TASK_STATUS_META } from '../../api/modules/admin-query'
import type { TaskProgressive } from '../../api/modules/order-supervision'
import type { AdminOrderVo, AdminTaskVo } from '../../types/admin'

/**
 * 任务监管 Tab（REQ-FRONTEND-001 §2b，仅执行中订单）：
 * 作业上下文 + 图传只读接入 + 遥测摘要；无任何开播/停播控件（ADR-0004 旁听语义）。
 */
const props = defineProps<{
  order: AdminOrderVo
  task?: AdminTaskVo
  liveDetail?: TaskProgressive | null
  /** 作业设备（useOrderDetail 三级回退后的契约 deviceId）；undefined = 解析中，null = 无作业设备 */
  deviceId?: string | null
}>()

const emit = defineEmits<{
  (e: 'back-to-manage'): void
}>()

const router = useRouter()

const go = (to: RouteLocationRaw) => {
  void router.push(to).catch(() => undefined)
}

const context = computed(() => [
  { label: '订单号', value: props.order.orderNum || '—' },
  { label: '任务', value: props.order.taskName || props.task?.taskName || '—' },
  { label: '用户', value: props.order.ownerName || '—' },
  { label: '飞手', value: props.task?.riderName || '—' },
  { label: '作业无人机', value: props.deviceId || '—' },
  {
    label: '任务状态',
    value: props.task
      ? props.task.taskStatusDesc ||
        TASK_STATUS_META[props.task.taskStatus ?? '']?.label ||
        props.task.taskStatus
      : '—',
  },
])
</script>

<template>
  <div class="mt-4 flex flex-col gap-4">
    <section class="panel-card p-5">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div class="section-title">任务监管</div>
          <div class="section-hint">仅执行中订单可监看：视频与遥测均为只读旁听，不含启停控制。</div>
        </div>
        <div class="flex flex-wrap gap-2">
          <el-button @click="emit('back-to-manage')">返回订单管理</el-button>
          <el-button
            type="primary"
            @click="go({ name: 'order-supervise', params: { orderNum: props.order.orderNum } })"
          >
            全屏监管
          </el-button>
        </div>
      </div>

      <div class="mt-4 grid gap-4 lg:grid-cols-[minmax(0,65fr)_minmax(0,35fr)]">
        <LiveStage :live-detail="props.liveDetail" :device-id="props.deviceId" />

        <div class="flex flex-col gap-4">
          <section class="panel-card context-panel p-4">
            <div class="panel-title">作业上下文</div>
            <div class="mt-3 flex flex-col gap-2">
              <div v-for="item in context" :key="item.label" class="context-row">
                <span>{{ item.label }}</span>
                <strong>{{ item.value }}</strong>
              </div>
            </div>
            <div class="mt-3 flex flex-wrap gap-2">
              <el-button
                size="small"
                @click="go({ name: 'users', query: props.order.userId ? { id: String(props.order.userId) } : {} })"
              >
                查看用户
              </el-button>
              <el-button
                size="small"
                @click="go({ name: 'pilots', query: props.task?.riderName ? { q: props.task.riderName } : {} })"
              >
                查看飞手
              </el-button>
            </div>
          </section>

          <TelemetryPanel :order-num="props.order.orderNum || ''" :device-id="props.deviceId" />
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.section-title {
  font-size: 1.02rem;
  font-weight: 800;
  color: var(--text-strong);
}

.section-hint {
  margin-top: 0.3rem;
  font-size: 0.85rem;
  color: var(--text-secondary);
}

.context-panel {
  border-color: var(--border);
  background: var(--bg-sunken);
}

.panel-title {
  font-size: 0.98rem;
  font-weight: 800;
  color: var(--text-strong);
}

.context-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  font-size: 0.9rem;
  color: var(--text-regular);
}

.context-row strong {
  color: var(--text-strong);
  font-weight: 600;
  text-align: right;
}
</style>
