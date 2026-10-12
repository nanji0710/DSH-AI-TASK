/**
 * TaskPulse 共享数据模型。
 *
 * 本文件被**宿主半边与浏览器半边同时引用**，因此必须保持纯净：
 * 只允许类型、常量与纯函数 —— 严禁 import `node:*`、React 或任何运行时依赖。
 *
 * 字段命名对齐《DSH_TaskPulse_V3.0_产品设计与架构规范》第 3 节数据模型。
 */

/** AgentTask 状态机（规范 4）：START → RUNNING → { SUCCESS | ERROR | WAIT_CONFIRM | BLOCKED }。 */
export const TASK_STATUS = {
  /** 已创建但尚未开始执行。 */
  START: 'START',
  /** 执行中。 */
  RUNNING: 'RUNNING',
  /** 等待用户确认。 */
  WAIT_CONFIRM: 'WAIT_CONFIRM',
  /** 完成。 */
  SUCCESS: 'SUCCESS',
  /** 异常。 */
  ERROR: 'ERROR',
  /** 阻塞（被中止 / 无法继续）。 */
  BLOCKED: 'BLOCKED'
} as const

export type TaskStatus = (typeof TASK_STATUS)[keyof typeof TASK_STATUS]

/** 状态 → UI 语义色（规范 7：运行=蓝 等待确认=黄 完成=绿 异常=红 阻塞=橙）。 */
export const STATUS_TONE: Record<TaskStatus, 'blue' | 'yellow' | 'green' | 'red' | 'orange' | 'gray'> = {
  START: 'gray',
  RUNNING: 'blue',
  WAIT_CONFIRM: 'yellow',
  SUCCESS: 'green',
  ERROR: 'red',
  BLOCKED: 'orange'
}

/** 状态 → 中文短标签。 */
export const STATUS_LABEL: Record<TaskStatus, string> = {
  START: '待开始',
  RUNNING: '进行中',
  WAIT_CONFIRM: '待确认',
  SUCCESS: '已达成',
  ERROR: '异常',
  BLOCKED: '阻塞'
}

/** 已完成、不再占据「活跃」语义的状态集合。 */
export const TERMINAL_STATUSES: TaskStatus[] = [TASK_STATUS.SUCCESS, TASK_STATUS.ERROR, TASK_STATUS.BLOCKED]

/**
 * 超过一天没有新操作 ⇒ 从活跃列表移入 History。
 *
 * 规范 6 原定 30 分钟，这里按用户明确要求放宽到 24 小时
 * （「任务超过一天没有新操作，就归到历史中」）—— 半小时对于
 * 「刚做完、还想回头看一眼」的场景太短，会把仍在意的东西过早推进历史。
 */
export const INACTIVE_ARCHIVE_AFTER_MS = 24 * 60 * 60 * 1000

/** Timeline 单行三态（规范 8：✓ 完成 / ● 进行中 / ○ 未开始）。 */
export type TimelineState = 'done' | 'active' | 'todo' | 'failed'

export interface TimelineEntry {
  /** 事件发生时间（epoch ms）。 */
  time: number
  /** 人类可读动作，如「读取文件」「执行命令」。 */
  action: string
  /** 动作细节（参数摘要 / 命令 / 路径），已截断。 */
  detail?: string
  /** 该行状态。 */
  status: TimelineState
  /** 产生该行的事件在会话日志中的 seq（用于去重与定位）。 */
  seq?: number
}

/**
 * 等待确认事项（规范 9：AI 建议 + 修改内容 + 确认按钮）。
 *
 * DSH 有两条互相独立的「等人」通道，语义都是「整轮停住，等用户拍板」：
 * - `approval` —— 审批通道（`approval/asked`），问的是「能不能动这个文件/命令」；
 * - `question` —— 提问通道（`ask_user_question` / `exit_plan_mode`），问的是「你想怎么做」。
 * 两者共用同一个挂起态，因此这里用一个判别字段区分文案，而不是各起一套状态。
 */
export interface PendingConfirm {
  id: string
  /** 挂起通道：审批 or 提问。决定确认卡片的标题文案。 */
  kind: 'approval' | 'question'
  /** 触发确认的工具名。 */
  toolName: string
  /** 工具调用 id，用于关联 tool/call。 */
  callId?: string
  /** 请求确认的原因（AI 建议）。 */
  reason?: string
  /** 被审阅的内容摘要（修改内容）。 */
  preview?: string
  time: number
}

/**
 * 单个会话的 AgentTask 运行态（宿主侧归约产物，wire 给浏览器半边）。
 * 这是「当前正在执行的任务」的权威描述。
 */
export interface TaskDetail {
  /** 会话 id，作为任务主键（DSH 中一次对话 = 一条任务流）。 */
  id: string
  sessionId: string
  workspaceId: string | null
  /** 任务标题（会话标题）。 */
  title: string
  status: TaskStatus
  /** 启发式进度 0..1（由步骤数推导，UI 以「第 N 步 + 耗时」为主展示）。 */
  progress: number
  /** 当前步骤的人类可读描述，如「执行命令」。 */
  currentStep: string | null
  /** 当前步骤细节。 */
  currentDetail: string | null
  /** Agent 名（agentPreset 投影，如 DeepSeek-Coder）。 */
  agent: string | null
  /** 模型名。 */
  model: string | null
  /**
   * 对话维度基准时间：该会话的真实创建时间（`session.header.createdAt`）。
   *
   * ⚠️ 这里**不是**运行起点 —— 早先的实现把「插件首次观测到该会话的时刻」写进本字段，
   * 导致所有在插件加载前就已存在的会话共享同一个数值，列表上「运行时间」因此相同。
   * 运行耗时一律用 `runStartedAt`。
   */
  startedAt: number
  /**
   * 本轮运行起点：来自该对话自己的 `user/message` / `turn/start` 事件时间。
   *
   * 为 `null` 表示**从未观测到本轮起点**（例如插件启动时该会话已经在跑）。
   * 此时耗时必须显示 `—` 而不是拿 `startedAt` 硬算 —— 编造出来的数字正是「两条对话
   * 运行时间相同」的根源。
   */
  runStartedAt: number | null
  /** 最近一次动作时间。 */
  lastActionTime: number
  /** 结束时间（终态时写入）。 */
  finishedAt: number | null
  /** 当前 turn / step 序号。 */
  turn: number
  step: number
  /** 累计工具调用数。 */
  toolCalls: number
  /** 累计步骤数。 */
  steps: number
  /** 最近错误信息。 */
  error: string | null
  /** 等待确认事项；非 WAIT_CONFIRM 时为 null。 */
  pendingConfirm: PendingConfirm | null
  /** 最近动作时间线（时间倒序由 UI 决定，此处为发生顺序，尾部最新）。 */
  timeline: TimelineEntry[]
}

/** 工作区聚合视图（规范 4 + 5）。 */
export interface WorkspaceGroupView {
  id: string
  name: string
  path: string
  /** 该工作区下的会话数。 */
  conversationCount: number
  /** 状态计数（用于 `🟦 2运行 / 🟡 1确认` 展示）。 */
  counts: StatusCounts
  updatedAt: number
}

export interface StatusCounts {
  running: number
  waitConfirm: number
  success: number
  error: number
  blocked: number
  total: number
}

export function emptyCounts(): StatusCounts {
  return { running: 0, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 0 }
}

export function addToCounts(counts: StatusCounts, status: TaskStatus): StatusCounts {
  const next: StatusCounts = { ...counts, total: counts.total + 1 }
  switch (status) {
    case TASK_STATUS.RUNNING:
    case TASK_STATUS.START:
      next.running += 1
      break
    case TASK_STATUS.WAIT_CONFIRM:
      next.waitConfirm += 1
      break
    case TASK_STATUS.SUCCESS:
      next.success += 1
      break
    case TASK_STATUS.ERROR:
      next.error += 1
      break
    case TASK_STATUS.BLOCKED:
      next.blocked += 1
      break
  }
  return next
}

/** 历史记录条目（规范 6：隐藏后保存 History）。 */
export interface HistoryItem {
  id: string
  sessionId: string
  workspaceId: string | null
  workspaceName: string
  title: string
  status: TaskStatus
  startedAt: number
  finishedAt: number
  /** 本轮耗时（ms）；未观测到运行起点时为 `null`（UI 显示 `—`，不编造数字）。 */
  duration: number | null
  steps: number
  toolCalls: number
  error: string | null
  /** 结束原因摘要。 */
  summary: string
}

/**
 * 浏览器半边向宿主半边请求的响应体（`/api/dsh-taskpulse/snapshot`）。
 *
 * `ok === false` 时只有 `error`，不携带任何载荷 —— 类型必须如实表达这一点，
 * 否则实现方会被迫在错误分支里伪造空载荷。
 */
export interface DetailResponse {
  ok: boolean
  /** 失败原因（跨半边通道错误不静默，UI 据此显式提示）。 */
  error?: string
  /** 会话 id → 任务详情；仅在 `ok === true` 时存在。 */
  details?: Record<string, TaskDetail>
}

/** 浏览器半边向宿主半边请求的响应体（`/api/dsh-taskpulse/history`）。 */
export interface HistoryResponse {
  ok: boolean
  error?: string
  items?: HistoryItem[]
}
