/**
 * 状态机与纯归约函数。
 *
 * 《DSH_TaskPulse_V3.0_产品设计与架构规范》第 4 节：
 *   START → RUNNING → { SUCCESS | ERROR | WAIT_CONFIRM | BLOCKED }
 *
 * 这里只放**纯函数**，宿主 Store 与浏览器 Store 共用同一套转移规则，
 * 保证两侧对「当前处于什么状态」的判断永不漂移。
 */

import {
  INACTIVE_ARCHIVE_AFTER_MS,
  STATUS_LABEL,
  TASK_STATUS,
  TERMINAL_STATUSES,
  type TaskDetail,
  type TaskStatus
} from './types'

/** 状态是否已结束。 */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.includes(status)
}

/** 状态中文名。 */
export function statusLabel(status: TaskStatus): string {
  return STATUS_LABEL[status] ?? status
}

/**
 * 合法转移表。`WAIT_CONFIRM → RUNNING` 是确认后回到执行；
 * `BLOCKED → RUNNING` 允许用户重新驱动同一会话。
 */
const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  START: [TASK_STATUS.RUNNING, TASK_STATUS.WAIT_CONFIRM, TASK_STATUS.SUCCESS, TASK_STATUS.ERROR, TASK_STATUS.BLOCKED],
  RUNNING: [TASK_STATUS.WAIT_CONFIRM, TASK_STATUS.SUCCESS, TASK_STATUS.ERROR, TASK_STATUS.BLOCKED, TASK_STATUS.RUNNING],
  WAIT_CONFIRM: [TASK_STATUS.RUNNING, TASK_STATUS.ERROR, TASK_STATUS.BLOCKED, TASK_STATUS.SUCCESS],
  SUCCESS: [TASK_STATUS.RUNNING, TASK_STATUS.SUCCESS],
  ERROR: [TASK_STATUS.RUNNING, TASK_STATUS.ERROR, TASK_STATUS.SUCCESS],
  BLOCKED: [TASK_STATUS.RUNNING, TASK_STATUS.BLOCKED, TASK_STATUS.SUCCESS]
}

/** 判断一次状态转移是否合法（用于自检与防御）。 */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * 归档规则：**超过一天没有新操作 ⇒ 移入 History**。
 *
 * 规范 6 原定「SUCCESS + 30 分钟」，现在按用户明确要求改为
 * 「任何状态 + 24 小时无新操作」。两点必须说清：
 *
 *  1. 归档不等于删除 —— 记录仍完整保留在「历史」页签里，可随时回看；
 *     只是不再占据「活跃任务」的位置。这正是用户要的效果。
 *  2. 状态不限。一条 RUNNING 的任务若 24 小时没有任何事件，
 *     它事实上已经死了（进程被杀 / 网络断开 / 会话被弃），
 *     继续以「运行中」挂在列表上才是真正的误报。
 *
 * 「异常必须可见」的原则仍在生效：ERROR / BLOCKED 在 24 小时内永不隐藏，
 * 足以让用户发现并处理；超过一天后治理价值已低于列表噪音成本。
 */
export function shouldArchiveInactive(
  task: Pick<TaskDetail, 'lastActionTime'>,
  now: number
): boolean {
  return now - task.lastActionTime >= INACTIVE_ARCHIVE_AFTER_MS
}

/**
 * 启发式进度：DSH 不暴露「总步数」，所以进度由已完成步骤数渐进逼近 1，
 * 终态直接给 0 / 1。UI 主展示用「第 N 步 + 耗时」，进度条仅作辅助。
 */
export function deriveProgress(status: TaskStatus, steps: number): number {
  switch (status) {
    case TASK_STATUS.SUCCESS:
      return 1
    case TASK_STATUS.START:
      return 0
    case TASK_STATUS.WAIT_CONFIRM:
      return Math.min(0.9, 0.2 + steps * 0.1)
    case TASK_STATUS.ERROR:
    case TASK_STATUS.BLOCKED:
      return Math.min(0.95, 0.2 + steps * 0.1)
    case TASK_STATUS.RUNNING:
    default:
      return Math.min(0.95, 0.1 + steps * 0.12)
  }
}

/** 人类可读耗时：`00:12:36` / `12:36` / `45秒`。 */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) ms = 0
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const pad = (n: number) => String(n).padStart(2, '0')
  if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
  if (minutes > 0) return `${pad(minutes)}:${pad(seconds)}`
  return `${seconds}秒`
}

/**
 * 人类可读相对时间（规范 5：Conversation 展示「最近动作时间」）。
 */
export function formatRelativeTime(time: number, now: number): string {
  const delta = now - time
  if (!Number.isFinite(delta) || delta < 0) return '刚刚'
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return '刚刚'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return new Date(time).toLocaleDateString()
}

/**
 * 本轮运行耗时文本；**从未观测到运行起点时返回 `—`**。
 *
 * 这里刻意不做任何兜底：早先的实现用 `(finishedAt ?? now) - startedAt` 计算，
 * 而 `startedAt` 当时是「插件首次观测到该会话的时刻」，导致所有在插件加载前
 * 就已存在的会话共享同一个基准，列表上多条对话的「运行时间」因此完全相同
 * （用户报告的缺陷）。现在的规则是：没有该对话自己的运行起点，就显示 `—`，
 * 宁可留白也不编造一个看起来合理却错误的数字。
 */
export function runDuration(task: Pick<TaskDetail, 'runStartedAt' | 'finishedAt'>, now: number): string {
  if (task.runStartedAt === null || task.runStartedAt === undefined) return '—'
  const end = task.finishedAt ?? now
  return formatDuration(end - task.runStartedAt)
}

/**
 * 列表主文案：只暴露「状态 + 当前步骤」两项（用户明确要求列表不展示工具调用与子代理）。
 *
 * 步骤缺失时按状态给出确定性的兜底文案，避免卡片出现空行：
 * 运行中 → 「思考中」，待确认 → 「等待确认」，其余终态 → 不显示步骤行（返回 null）。
 */
export function taskStepText(task: Pick<TaskDetail, 'status' | 'currentStep'>): string | null {
  if (task.currentStep !== null && task.currentStep !== undefined && task.currentStep !== '') {
    return task.currentStep
  }
  switch (task.status) {
    case TASK_STATUS.RUNNING:
    case TASK_STATUS.START:
      return '思考中'
    case TASK_STATUS.WAIT_CONFIRM:
      return '等待确认'
    default:
      return null
  }
}
