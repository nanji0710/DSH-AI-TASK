/**
 * TaskStore —— 宿主半边的任务归约中心（规范 6 事件流的第一段）。
 *
 * 事件流（规范 5 硬性链路）：
 *   DSH Event → Event Service → Task Store → UI刷新 → History保存
 *
 * 数据来源说明（重要，避免误解）：
 * DSH 真实存在的会话事件是 `session/event` 上流动的 `turn/start`、`step/start`、
 * `tool/call`、`tool/result`、`approval/asked`、`assistant/message`…（见 dsh-session 的
 * KNOWN_SESSION_EVENT_TYPES）。规范三里写的 `workspace.created` / `agent.started` /
 * `tool.called` 在 DSH 中并不存在，故本 Store 直接订阅真实事件名并在内部映射。
 */

import {
  TASK_STATUS,
  isTerminal,
  type HistoryItem,
  type PendingConfirm,
  type TaskDetail,
  type TaskStatus,
  type TimelineEntry,
  deriveProgress,
  questionText,
  shouldArchiveInactive,
  summarizeToolArguments,
  summarizeValue,
  toolLabel
} from '../models'
import type { SessionEventLike, SessionLike } from './session-like'

/** Timeline 上限：只保留最近 N 条，避免长会话吃内存（规范要求高信息密度）。 */
const TIMELINE_LIMIT = 40

/**
 * 会阻塞整轮执行、等用户答复的工具。
 *
 * DSH 里有**两条互相独立**的「等人」通道，只有第一条会发 `approval/asked`：
 *   1. 审批通道 —— 工具调用前询问是否放行，事件为 `approval/asked` / `approval/decided`；
 *   2. 提问通道 —— `ask_user_question` 与 `exit_plan_mode` 走 `ctx.userQuestions`
 *      能力面（`dsh-tool-ask-user` / `dsh-plan-mode`），**宿主不为它们追加任何事件**，
 *      会话流里只有一条普通的 `tool/call`，要等用户答完才出 `tool/result`。
 *
 * 只订阅第一条通道，就会把「正在等你回答」误报成「运行中」——用户报告的正是这个。
 * 下面这组工具名按「会阻塞等人」的语义补上第二条通道，与审批通道对称。
 */
const BLOCKING_ASK_TOOLS = new Set(['ask_user_question', 'exit_plan_mode'])

interface TaskRecord extends TaskDetail {
  /** 已完成步骤数（用于进度与统计）。 */
  completedSteps: number
}

/**
 * 宿主侧任务归约器。
 *
 * 纯内存、无副作用、可被反复重建：它从会话事件流**折叠**出任务视图，
 * 因此进程重启后只要事件流还在，任务历史就能重放。
 */
export class TaskStore {
  private readonly tasks = new Map<string, TaskRecord>()
  private readonly history = new Map<string, HistoryItem>()
  private readonly listeners = new Set<() => void>()
  /** sessionId → workspaceId 归属缓存（由外部注入，随 workspace 变化失效）。 */
  private workspaceOf: (sessionId: string) => string | null = () => null
  private now: () => number = () => Date.now()

  /** 注入会话 → 工作区归属解析（宿主 workspace 服务提供）。 */
  setWorkspaceResolver(resolve: (sessionId: string) => string | null): void {
    this.workspaceOf = resolve
  }

  /** 注入时钟（测试用）。 */
  setClock(now: () => number): void {
    this.now = now
  }

  /** 订阅任务变化（Event Service → UI 推送）。 */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch {
        /* 单个订阅者异常不得影响归约 */
      }
    }
  }

  /** 全部活跃任务（含刚结束、尚未进入 History 的）。 */
  listActive(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  /** 按会话取任务。 */
  get(sessionId: string): TaskRecord | undefined {
    return this.tasks.get(sessionId)
  }

  /** 活跃任务的对外投影（剥掉内部字段）。 */
  snapshotDetails(): Record<string, TaskDetail> {
    const out: Record<string, TaskDetail> = {}
    for (const [id, task] of this.tasks) out[id] = toDetail(task)
    return out
  }

  /** 历史记录（最新在前）。 */
  listHistory(): HistoryItem[] {
    return [...this.history.values()].sort((a, b) => b.finishedAt - a.finishedAt)
  }

  /**
   * 确保会话有对应任务记录。
   * @param sessionId - DSH 会话 id（= 任务主键）。
   * @param title - 会话标题；未知时用短 id 兜底。
   * @param session - 可选的宿主 Session 实例，用于回填标题等元信息。
   */
  ensureTask(sessionId: string, title?: string, session?: SessionLike): TaskRecord {
    let task = this.tasks.get(sessionId)
    if (task === undefined) {
      const now = this.now()
      task = {
        id: sessionId,
        sessionId,
        workspaceId: this.workspaceOf(sessionId),
        title: cleanTitle(title) ?? shortId(sessionId),
        status: TASK_STATUS.START,
        progress: 0,
        currentStep: null,
        currentDetail: null,
        agent: null,
        model: null,
        startedAt: readSessionCreatedAt(session) ?? now,
        runStartedAt: null,
        lastActionTime: now,
        finishedAt: null,
        turn: 0,
        step: 0,
        toolCalls: 0,
        steps: 0,
        completedSteps: 0,
        error: null,
        pendingConfirm: null,
        timeline: []
      }
      this.tasks.set(sessionId, task)
    } else {
      // 归属 / 标题可能后到（workspace 服务异步就绪、标题由 LLM 生成）。
      const resolved = this.workspaceOf(sessionId)
      if (resolved !== null && task.workspaceId !== resolved) task.workspaceId = resolved
      const nextTitle = cleanTitle(title) ?? readSessionTitle(session)
      if (nextTitle !== undefined) task.title = nextTitle
    }
    return task
  }

  /**
   * 应用一条会话事件。
   *
   * 这是 Store 的唯一入口：Event Service 把 `session/event` 的 (session, event)
   * 原样送进来，所有状态推导都发生在这里。
   */
  applyEvent(sessionId: string, event: SessionEventLike, session?: SessionLike): void {
    const type = event?.type
    if (typeof type !== 'string') return
    const task = this.ensureTask(sessionId, undefined, session)
    const data = (event.data ?? {}) as Record<string, any>
    const time = typeof event.time === 'number' ? event.time : this.now()
    let changed = true

    switch (type) {
      case 'turn/start': {
        task.turn = typeof data.turn === 'number' ? data.turn : task.turn + 1
        task.status = TASK_STATUS.RUNNING
        task.finishedAt = null
        task.error = null
        // 本轮起点：只由该对话自己的事件写入，绝不与其他对话共享基准。
        task.runStartedAt = time
        task.currentStep = task.currentStep ?? '分析请求'
        this.pushTimeline(task, { time, action: '开始新一轮处理', status: 'done', seq: event.seq })
        break
      }
      case 'turn/end': {
        task.status = TASK_STATUS.SUCCESS
        task.finishedAt = time
        task.pendingConfirm = null
        this.pushTimeline(task, { time, action: '本轮处理完成', status: 'done', seq: event.seq })
        break
      }
      case 'step/start': {
        task.step = typeof data.step === 'number' ? data.step : task.step + 1
        task.status = TASK_STATUS.RUNNING
        if (task.currentStep === null) task.currentStep = '思考中'
        break
      }
      case 'step/end': {
        task.completedSteps += 1
        task.steps += 1
        break
      }
      case 'tool/call': {
        const name = typeof data.name === 'string' ? data.name : undefined
        const detail = summarizeToolArguments(data.arguments)
        const callId = typeof data.callId === 'string' ? data.callId : undefined
        task.toolCalls += 1
        if (name !== undefined && BLOCKING_ASK_TOOLS.has(name)) {
          // 提问通道：这条 tool/call 之后整轮就停住了，等用户答复。
          // 它就是「等待确认」，与 approval/asked 同义，只是事件名不同。
          task.status = TASK_STATUS.WAIT_CONFIRM
          task.pendingConfirm = {
            id: callId ?? String(event.seq ?? ''),
            kind: 'question',
            toolName: name,
            callId,
            reason: questionText(data.arguments),
            preview: undefined,
            time
          }
          task.currentStep = `等待确认：${toolLabel(name)}`
        } else {
          task.status = task.status === TASK_STATUS.WAIT_CONFIRM ? TASK_STATUS.WAIT_CONFIRM : TASK_STATUS.RUNNING
          task.currentStep = toolLabel(name)
        }
        task.currentDetail = detail || null
        this.pushTimeline(task, {
          time,
          action: toolLabel(name),
          detail,
          status: 'active',
          seq: event.seq
        })
        break
      }
      case 'tool/result': {
        const isError = data?.message?.isError === true || data.error !== undefined
        // tool/result 的消息体带着 toolCallId（`dsh-llm` 的 createToolResultMessage
        // 写入 `toolCallId: input.callId`），据此与挂起的提问精确配对。
        const resultCallId = typeof data?.message?.toolCallId === 'string'
          ? data.message.toolCallId
          : typeof data.callId === 'string'
            ? data.callId
            : undefined
        const answered = task.pendingConfirm !== null
          && resultCallId !== undefined
          && task.pendingConfirm.callId === resultCallId
        const last = task.timeline[task.timeline.length - 1]
        if (last !== undefined && last.status === 'active') {
          last.status = isError ? 'failed' : 'done'
          last.time = time
        } else {
          this.pushTimeline(task, {
            time,
            action: isError ? '工具调用失败' : '工具调用完成',
            status: isError ? 'failed' : 'done',
            seq: event.seq
          })
        }
        if (isError) {
          const message = data.error?.message ?? data?.message?.content
          task.error = summarizeValue(message, 200) || '工具调用失败'
          task.status = TASK_STATUS.ERROR
        } else if (answered) {
          // 用户已答复：确认事项解除，整轮继续跑（与 approval/decided 对称）。
          task.status = TASK_STATUS.RUNNING
          task.currentStep = '继续处理'
        }
        if (answered || isError) task.pendingConfirm = null
        if (data.currentStep !== undefined) task.currentStep = summarizeValue(data.currentStep, 60)
        break
      }
      case 'approval/asked': {
        // 规范 9：确认中心。appearance 即「等待确认」，必须压过 RUNNING。
        task.status = TASK_STATUS.WAIT_CONFIRM
        task.pendingConfirm = {
          id: String(data.id ?? event.seq ?? ''),
          kind: 'approval',
          toolName: typeof data.toolName === 'string' ? data.toolName : '操作',
          callId: typeof data.callId === 'string' ? data.callId : undefined,
          reason: summarizeValue(data.reason, 200) || undefined,
          preview: summarizeValue(data.preview ?? data.detail, 200) || undefined,
          time
        }
        task.currentStep = `等待确认：${toolLabel(data.toolName)}`
        this.pushTimeline(task, {
          time,
          action: `等待确认 ${toolLabel(data.toolName)}`,
          detail: task.pendingConfirm.reason,
          status: 'active',
          seq: event.seq
        })
        break
      }
      case 'approval/decided': {
        const outcome = summarizeValue(data.outcome, 40)
        task.pendingConfirm = null
        // 官方结果词表只有三种：`allowed-once`（唯一的放行）、`rejected`（拒绝）、
        // `cancelled`（中止）；没有应答方时落成 `unavailable`
        // （见 dsh-user-approval/lib/index.js:29-33 与 :170-186）。
        // 因此判据是「是不是放行」，而不是去猜哪些词表示拒绝 ——
        // 反过来写会把 cancelled / unavailable 误报成「在跑」。
        task.status = outcome === 'allowed-once' ? TASK_STATUS.RUNNING : TASK_STATUS.BLOCKED
        this.pushTimeline(task, {
          time,
          action: `确认结果：${outcome || '已处理'}`,
          status: task.status === TASK_STATUS.BLOCKED ? 'failed' : 'done',
          seq: event.seq
        })
        break
      }
      case 'agent-preset/selected': {
        if (typeof data.agentPreset === 'string') task.agent = data.agentPreset
        break
      }
      case 'model/selection': {
        const model = data.model ?? data.selection?.model
        if (typeof model === 'string') task.model = model
        break
      }
      case 'session/title': {
        if (typeof data.title === 'string') task.title = data.title
        break
      }
      case 'assistant/message': {
        if (task.status === TASK_STATUS.START) task.status = TASK_STATUS.RUNNING
        break
      }
      case 'user/message': {
        const source = data.source as Record<string, unknown> | undefined
        const kind = typeof source?.kind === 'string' ? source.kind : undefined
        // 提问被答复时，宿主会写一条 `source.kind === "user-question-reply"` 的消息
        // （见 dsh-user-questions）。它不是「用户要求干活」，而是「用户答完了」——
        // 语义上等价于审批通道的 approval/decided，必须解除挂起的确认。
        // 用 callId 与挂起的提问配对，答的是别的问题就不动当前状态。
        const replyCallId = typeof source?.callId === 'string' ? source.callId : undefined
        const answersPending = kind === 'user-question-reply'
          && task.pendingConfirm !== null
          && (replyCallId === undefined || task.pendingConfirm.callId === replyCallId)
        if (answersPending) {
          task.pendingConfirm = null
          task.status = TASK_STATUS.RUNNING
          task.currentStep = '继续处理'
          this.pushTimeline(task, {
            time,
            action: '已答复提问',
            status: 'done',
            seq: event.seq
          })
          break
        }
        // 该对话真实用户消息（`source.kind === "user"` 才排除工具回填等合成消息）。
        // 它是「用户要求干活」的时刻，即本轮运行的语义起点；
        // 只在从未有起点、或上一轮已结束（新的一轮）时写入，不覆盖进行中的起点。
        const fromUser = kind === 'user'
        if (fromUser && (task.runStartedAt === null || isTerminal(task.status))) {
          task.runStartedAt = time
          if (isTerminal(task.status)) {
            task.status = TASK_STATUS.RUNNING
            task.finishedAt = null
            task.error = null
          }
        } else {
          changed = false
        }
        break
      }
      case 'compaction/start': {
        task.currentStep = '压缩上下文'
        this.pushTimeline(task, { time, action: '压缩上下文', status: 'active', seq: event.seq })
        break
      }
      case 'compaction/end': {
        const last = task.timeline[task.timeline.length - 1]
        if (last !== undefined && last.action === '压缩上下文') last.status = 'done'
        break
      }
      case 'todo/write': {
        task.currentStep = '更新任务清单'
        break
      }
      default:
        changed = false
    }

    if (changed) {
      task.lastActionTime = time
      task.progress = deriveProgress(task.status, task.steps)
      if (task.workspaceId === null) task.workspaceId = this.workspaceOf(sessionId)
      if (task.status === TASK_STATUS.SUCCESS) this.archiveIfDone(task, time)
      this.notify()
    }
  }

  /**
   * 会话级运行状态变化（`api-session/status`，权威信号）。
   *
   * 该信号由宿主 agent/status 派生，比逐条事件更可靠地表达「这个会话到底在不在跑」，
   * 因此这里以它为准校正 RUNNING / SUCCESS。
   */
  applyRunning(sessionId: string, running: boolean, session?: SessionLike): void {
    const task = this.ensureTask(sessionId, undefined, session)
    const time = this.now()
    let changed = false
    if (running) {
      if (task.status !== TASK_STATUS.WAIT_CONFIRM) {
        if (task.status !== TASK_STATUS.RUNNING) {
          task.status = TASK_STATUS.RUNNING
          task.finishedAt = null
          changed = true
        }
      }
    } else if (task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.START) {
      // 一轮跑完但没有 turn/end（例如被中止）：标成功，交给 24 小时归档规则处理。
      task.status = TASK_STATUS.SUCCESS
      task.finishedAt = time
      changed = true
    }
    if (changed) {
      task.lastActionTime = time
      task.progress = deriveProgress(task.status, task.steps)
      if (task.status === TASK_STATUS.SUCCESS) this.archiveIfDone(task, time)
      this.notify()
    }
  }

  /**
   * 回填本轮运行起点（插件启动时已在运行的会话，订阅前的事件已经流过）。
   *
   * 只接受**该会话自己**的起点时间；绝不写入任何跨会话共享的基准值 ——
   * 那正是列表上多条对话耗时雷同的成因。
   * 已经观测到起点（值相同或更晚）时不覆盖，保证事件流比回填更权威。
   */
  applyRunStart(sessionId: string, runStartedAt: number): void {
    const task = this.tasks.get(sessionId)
    if (task === undefined) return
    if (!Number.isFinite(runStartedAt)) return
    if (task.runStartedAt !== null && task.runStartedAt <= runStartedAt) return
    task.runStartedAt = runStartedAt
    this.notify()
  }

  /** 会话异常（`api-session/error`）。 */
  applyError(sessionId: string, error: unknown, session?: SessionLike): void {    const task = this.ensureTask(sessionId, undefined, session)
    const time = this.now()
    task.status = TASK_STATUS.ERROR
    task.error = summarizeValue(error, 300) || '未知错误'
    task.finishedAt = time
    task.lastActionTime = time
    task.progress = deriveProgress(task.status, task.steps)
    this.pushTimeline(task, { time, action: '执行异常', detail: task.error, status: 'failed' })
    this.notify()
  }

  /** 会话被移除：把活跃任务落进 History。 */
  applyRemoved(sessionId: string): void {
    const task = this.tasks.get(sessionId)
    if (task === undefined) return
    this.archive(task, task.status === TASK_STATUS.RUNNING ? TASK_STATUS.BLOCKED : task.status, this.now(), '会话已关闭')
    this.tasks.delete(sessionId)
    this.notify()
  }

  /**
   * 归档巡检：**超过一天没有新操作的条目移入 History**（用户明确要求）。
   *
   * 与规范 6 原定的「SUCCESS + 30 分钟」相比有三处关键变化：
   *  1. 阈值 30 分钟 → 24 小时；
   *  2. 不再限定 SUCCESS —— 一条 24 小时没有任何事件的 RUNNING 任务
   *     事实上已经死了，继续显示「运行中」才是误报；
   *  3. 归档状态按当前状态如实记录（而非一律写成 SUCCESS），
   *     历史里看到的必须是真的发生过什么。
   *
   * 归还给 History 后，用户可以随时在「历史」页签回看；
   * 若该会话重新开始工作，`ensureTask` 会重新建立活跃记录。
   */
  sweep(now = this.now()): void {
    let changed = false
    for (const task of [...this.tasks.values()]) {
      if (shouldArchiveInactive(task, now)) {
        this.archive(task, task.status, now, `超过一天无操作（最后动作于 ${describeIdleSpan(now - task.lastActionTime)}前）`)
        this.tasks.delete(task.id)
        changed = true
      }
    }
    if (changed) this.notify()
  }

  private archiveIfDone(task: TaskRecord, now: number): void {
    if (shouldArchiveInactive(task, now)) {
      this.archive(task, task.status, now, '超过一天无操作')
      this.tasks.delete(task.id)
      this.notify()
    }
  }

  /** 写入 History（规范 3 数据模型的 History 环节）。 */
  private archive(task: TaskRecord, status: TaskStatus, now: number, summary: string): void {
    const finishedAt = task.finishedAt ?? now
    const item: HistoryItem = {
      id: task.id,
      sessionId: task.sessionId,
      workspaceId: task.workspaceId,
      workspaceName: task.workspaceId ?? '默认工作区',
      title: task.title,
      status,
      startedAt: task.startedAt,
      finishedAt,
      // 未观测到运行起点时写 null（UI 显示 `—`）；绝不拿对话创建时间冒充运行时长。
      duration: task.runStartedAt === null ? null : Math.max(0, finishedAt - task.runStartedAt),
      steps: task.steps,
      toolCalls: task.toolCalls,
      error: task.error,
      summary
    }
    this.history.set(item.id, item)
    // History 上限，防止无限增长。
    if (this.history.size > 200) {
      const oldest = [...this.history.values()].sort((a, b) => a.finishedAt - b.finishedAt)[0]
      if (oldest !== undefined) this.history.delete(oldest.id)
    }
  }

  /** 生成等待确认事项对应的任务快照（供浏览器半边确认中心读取）。 */
  pendingConfirms(): Array<PendingConfirm & { sessionId: string; title: string }> {
    const out: Array<PendingConfirm & { sessionId: string; title: string }> = []
    for (const task of this.tasks.values()) {
      if (task.pendingConfirm !== null) out.push({ ...task.pendingConfirm, sessionId: task.sessionId, title: task.title })
    }
    return out
  }

  /** 清理（插件卸载时调用）。 */
  dispose(): void {
    this.tasks.clear()
    this.listeners.clear()
  }

  private pushTimeline(task: TaskRecord, entry: TimelineEntry): void {
    task.timeline.push(entry)
    if (task.timeline.length > TIMELINE_LIMIT) task.timeline.splice(0, task.timeline.length - TIMELINE_LIMIT)
  }
}

/** 读取会话标题（多来源兜底）。 */
function readSessionTitle(session?: SessionLike): string | undefined {
  if (session === undefined || session === null) return undefined
  const header = session.header as Record<string, any> | undefined
  const candidates = [session.title, header?.title]
  for (const candidate of candidates) {
    const cleaned = cleanTitle(candidate)
    if (cleaned !== undefined) return cleaned
  }
  return undefined
}

function cleanTitle(title: unknown): string | undefined {
  if (typeof title !== 'string') return undefined
  const trimmed = title.trim()
  if (trimmed.length === 0) return undefined
  return trimmed.length > 80 ? `${trimmed.slice(0, 79)}…` : trimmed
}

/** 把空闲时长描述成「3小时」「2天」这类短语，用于 History 摘要。 */
function describeIdleSpan(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '刚刚'
  const hours = Math.floor(ms / 3600_000)
  if (hours < 24) return `${Math.max(1, hours)}小时`
  return `${Math.floor(hours / 24)}天`
}

function shortId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 12)}…` : id
}

/**
 * 读取会话真实创建时间（`session.header.createdAt`）。
 *
 * 这是**对话维度**的基准：DSH 在 `dsh-session/lib/index.js` 里写
 * `createdAt: Date.now()`（新建）/ `meta?.createdAt ?? Date.now()`（恢复），
 * 该值与会话一一对应，因此可作为稳定的对话起点。
 * 取不到时返回 undefined，由调用方回退，避免写进一个假的 0。
 */
function readSessionCreatedAt(session?: SessionLike): number | undefined {
  if (session === undefined || session === null) return undefined
  const header = session.header as Record<string, any> | undefined
  const value = header?.createdAt
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function toDetail(task: TaskRecord): TaskDetail {
  const { completedSteps: _ignored, ...detail } = task
  return detail
}
