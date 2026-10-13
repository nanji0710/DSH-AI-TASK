/**
 * EventService —— DSH Event → Task Store 的桥（规范 5 事件流第二段）。
 *
 * 规范三里列举的事件名（`workspace.created` / `agent.started` / `tool.called` …）
 * 在 DSH 中**并不存在**。本服务把规范事件语义映射到 DSH 真实事件上：
 *
 * | 规范事件                | DSH 真实来源                                        |
 * |------------------------|-----------------------------------------------------|
 * | workspace.created/updated/removed | `domain/changed`（domain==='workspace'）  |
 * | conversation.created    | `session/created` / `api-session/added`             |
 * | conversation.updated    | `session/event`（turn/step/tool 等逐条事件）        |
 * | conversation.finished   | `api-session/status`(running=false)                 |
 * | agent.started/finished  | `api-session/status`（由 agent/status 派生）        |
 * | agent.progress          | `session/event` 的 `step/start`、`tool/call`        |
 * | tool.called/finished    | `session/event` 的 `tool/call`、`tool/result`       |
 *
 * 全部订阅都通过 `ctx.on(name, handler)` 注册，由 Cordis 在本插件 fiber 卸载时
 * 自动回收，无需手工 dispose。
 */

import type { TaskStore } from '../store/task-store'
import type { SessionEventLike, SessionLike, SessionSummaryLike } from '../store/session-like'

/** 需要订阅的宿主事件名（集中声明，便于审计）。 */
const SESSION_EVENT = 'session/event'
const SESSION_CREATED = 'session/created'
const SESSION_DISPOSED = 'session/disposed'
const API_SESSION_ADDED = 'api-session/added'
const API_SESSION_REMOVED = 'api-session/removed'
const API_SESSION_STATUS = 'api-session/status'
const API_SESSION_ERROR = 'api-session/error'
const DOMAIN_CHANGED = 'domain/changed'
const AGENT_STATUS = 'agent/status'

/** 归档巡检间隔（阈值以天计，1 分钟精度足够）。 */
const SWEEP_INTERVAL_MS = 60 * 1000

export interface EventServiceDeps {
  ctx: any
  store: TaskStore
}

export class EventService {
  private readonly ctx: any
  private readonly store: TaskStore
  private sweepTimer: ReturnType<typeof setInterval> | null = null

  constructor(deps: EventServiceDeps) {
    this.ctx = deps.ctx
    this.store = deps.store
  }

  /** 安装全部订阅并做一次启动种子。 */
  start(): void {
    const ctx = this.ctx
    const store = this.store

    // ---- 会话 → 工作区归属解析（宿主 workspace 注册表是唯一权威） ----
    store.setWorkspaceResolver((sessionId) => this.resolveWorkspaceId(sessionId))

    // ---- 规范 conversation.created ----
    // 不在此建档：新建会话（含空白会话）此刻既没在跑也没有任何事件，建档只会
    // 造出停在 START（「待开始」）的僵尸条目。宿主随后发出的 api-session/added
    // （带 running 字段）与 session/event 才是可靠的建档时机。
    ctx.on?.(SESSION_CREATED, (session: SessionLike) => {
      void session
    })

    ctx.on?.(API_SESSION_ADDED, (summary: SessionSummaryLike) => {
      const id = summary?.sessionId ?? summary?.id
      if (typeof id !== 'string') return
      // 子代理会话归入其父会话，不单列（与浏览器半边 `origin === 'subagent'`
      // 的口径一致）。插件重启时宿主会对全部 live 会话补发 added，若不拦住，
      // 每个已跑完的子代理都会得到一条停在 START 的「待开始」僵尸卡
      // ——三任务显示异常的**直接现场**（b8a41501 / b925d768 / 7be4ac9d，
      // 全部 origin=subagent、父会话 session-2c6b93e3）。
      const session = safeSession(ctx, id)
      if (readSessionOrigin(session) === 'subagent') return
      if (summary?.running === true) {
        store.ensureTask(id, summary?.title, session)
        store.applyRunning(id, true, session)
      } else {
        // 非 running 的 added：只收敛既有记录，**绝不建档**。宿主对从未运行过的
        // 会话不会补发 status(false)，若在此建档，记录会永远停在 START（「待开始」）
        // ——三任务显示异常的第一成因。applyIdle 不建档，只把滞留的 START/RUNNING
        // 收敛为 SUCCESS。
        store.applyIdle(id)
      }
    })

    // ---- 规范 conversation.updated / agent.progress / tool.called / tool.finished ----
    // 无标签的 ctx.on 能收到全部 agent 的 session 事件；session 携带 id。
    ctx.on?.(SESSION_EVENT, (session: SessionLike, event: SessionEventLike) => {
      const id = session?.id
      if (typeof id !== 'string' || event === undefined || event === null) return
      // 子代理会话的事件不进入任务归约（同上，归入父会话语义）。
      if (readSessionOrigin(session) === 'subagent') return
      store.applyEvent(id, event, session)
    })

    // ---- 规范 conversation.finished / agent.started / agent.finished ----
    ctx.on?.(API_SESSION_STATUS, (sessionId: unknown, running: unknown) => {
      if (typeof sessionId !== 'string') return
      const session = safeSession(ctx, sessionId)
      if (readSessionOrigin(session) === 'subagent') return
      store.applyRunning(sessionId, running === true, session)
    })

    // 宿主 agent 级信号作为兜底（agent.id 与 session.id 在本插件中同键）。
    ctx.on?.(AGENT_STATUS, (payload: any) => {
      const agent = payload?.agent
      const id = agent?.session?.id ?? agent?.sessionId ?? agent?.id
      if (typeof id !== 'string') return
      const session = agent?.session ?? safeSession(ctx, id)
      if (readSessionOrigin(session) === 'subagent') return
      store.applyRunning(id, payload?.status === 'running', session)
    })

    // ---- 异常：规范 ERROR 状态 ----
    ctx.on?.(API_SESSION_ERROR, (sessionId: unknown, error: unknown) => {
      if (typeof sessionId !== 'string') return
      const session = safeSession(ctx, sessionId)
      if (readSessionOrigin(session) === 'subagent') return
      store.applyError(sessionId, error, session)
    })

    // ---- 会话关闭：规范 conversation.finished（任务落入 History） ----
    ctx.on?.(API_SESSION_REMOVED, (sessionId: unknown) => {
      if (typeof sessionId !== 'string') return
      store.applyRemoved(sessionId)
    })

    ctx.on?.(SESSION_DISPOSED, (session: SessionLike) => {
      if (typeof session?.id !== 'string') return
      store.applyRemoved(session.id)
    })

    // ---- 规范 workspace.updated / workspace.removed ----
    ctx.on?.(DOMAIN_CHANGED, (change: any) => {
      if (change?.domain !== 'workspace') return
      // 工作区变化只影响「归属」与「名称」，重算既有任务的归属即可。
      for (const task of store.listActive()) {
        task.workspaceId = this.resolveWorkspaceId(task.sessionId)
      }
    })

    // ---- 启动种子：把插件加载前已在运行的会话纳入监控 ----
    this.seedExistingSessions()
    this.subscribeWorkspaceChanges()

    // ---- 超过一天无操作的条目归档进 History（规范 6 的阈值已按用户要求放宽） ----
    this.sweepTimer = setInterval(() => {
      try {
        store.sweep()
      } catch {
        /* 巡检异常不得中断插件 */
      }
    }, SWEEP_INTERVAL_MS)
    this.sweepTimer.unref?.()
  }

  /** 卸载：清定时器。事件订阅由 Cordis fiber 负责回收。 */
  stop(): void {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
  }

  /**
   * 把当前**确实在运行**的 live 会话纳入监控。
   *
   * 只读取「有哪些会话、哪个在跑」（`sessions.list()` + `agents.get()`），
   * **不**回放历史事件：`Session.snapshotEvents()` 已被官方标注为
   * deprecated（禁止新增同步读取），Timeline 从插件启用后开始累积即可。
   *
   * ⚠️ 这里**只为正在运行的会话建档**，不再无差别地给每个 live 会话调
   * `ensureTask()`。原因：DSH 里 live 会话包含大量早已结束、只是还留在
   * 内存中的历史对话；给它们建档会让 `ensureTask` 的初始状态（START）
   * 直接暴露在列表上，形成一整屏「待开始」的假条目 —— 而这些会话既没在
   * 执行、也没有任何可观测的结束信号，插件根本无从判断它们的状态。
   * 诚实的做法是：**不确定的会话不展示**。它们一旦真的产生事件
   * （用户发消息、turn/start、approval/asked），事件处理器会立刻建档并
   * 给出准确状态。
   *
   * 已知取舍：插件启用**之前**就处于「等待确认」的会话无法在此刻被发现
   * （需要回放历史事件，而该 API 已弃用），只能在用户处理它产生新事件时
   * 进入列表。
   *
   * 运行起点必须补上：插件启动时已经在跑的会话，其 `turn/start` 与
   * `user/message` 事件都发生在订阅之前，若不回填，`runStartedAt` 永远是 null、
   * 耗时只能显示 `—`。官方为此提供了持久化投影
   * `sessionListMetadata`（`{ blank, lastPromptAt }`，定义见
   * `dsh-api-session-controller/lib/index.js:1789-1843`），其中 `lastPromptAt`
   * 正是该会话最后一条**真实用户消息**的时间 —— 与我们在 `user/message`
   * 分支写入的语义完全一致，因此可以安全采用。
   */
  private seedExistingSessions(): void {
    const ctx = this.ctx
    let sessions: SessionLike[] = []
    try {
      sessions = ctx.sessions?.list?.() ?? []
    } catch {
      return
    }
    for (const session of sessions) {
      const id = session?.id
      if (typeof id !== 'string') continue
      // 子代理会话归入其父会话，不单列。
      if (readSessionOrigin(session) === 'subagent') continue
      // 只有确认在跑的会话才建档；其余保持沉默，等待它们自己产生事件。
      if (readAgentRunning(ctx, id) !== true) continue
      this.store.ensureTask(id, undefined, session)
      this.store.applyRunning(id, true, session)
      const lastPromptAt = readLastPromptAt(ctx, session)
      if (lastPromptAt !== undefined) this.store.applyRunStart(id, lastPromptAt)
    }
  }

  /** 工作区列表变化时刷新归属（`list()` 是同步读取，成本低）。 */
  private subscribeWorkspaceChanges(): void {
    // domain/changed 已在上面订阅；此处仅做一次初始归属回填。
    for (const task of this.store.listActive()) {
      task.workspaceId = this.resolveWorkspaceId(task.sessionId)
    }
  }

  /** 会话 → 工作区 id。走宿主 workspace 注册表的 `sessionIds` 索引。 */
  private resolveWorkspaceId(sessionId: string): string | null {
    try {
      const registry = this.ctx.workspaceRegistry
      if (registry === undefined || registry === null) return null
      const list = registry.list?.() ?? []
      for (const workspace of list) {
        const ids: string[] = workspace?.sessionIds ?? []
        if (ids.includes(sessionId)) return String(workspace.id)
      }
    } catch {
      /* 注册表未就绪时静默降级为「无归属」 */
    }
    return null
  }
}

/** 安全读取 live session（可能不存在）。 */
function safeSession(ctx: any, id: string): SessionLike | undefined {
  try {
    return ctx.sessions?.get?.(id)
  } catch {
    return undefined
  }
}

/** 会话来源（`session.origin`）；'subagent' 表示由其他会话派生的子代理。 */
function readSessionOrigin(session: any): string | undefined {
  try {
    const origin = session?.origin
    return typeof origin === 'string' ? origin : undefined
  } catch {
    return undefined
  }
}

/** 读取 agent 运行状态；返回 undefined 表示未知。 */
function readAgentRunning(ctx: any, sessionId: string): boolean | undefined {
  try {
    const agent = ctx.agents?.get?.(sessionId)
    if (agent === undefined || agent === null) return undefined
    return agent.status === 'running'
  } catch {
    return undefined
  }
}

/**
 * 读取该会话最后一条真实用户消息时间（`sessionListMetadata.lastPromptAt`）。
 *
 * `ctx.sessionProjections.stateOf(session, key)` 在 key 未注册时返回 undefined
 * （见 dsh-session-projection/lib/index.js:127-132），因此这里全程防御式读取：
 * 拿不到就返回 undefined，让 `runStartedAt` 保持 null、UI 显示 `—`，
 * 而不是退回到某个共享的基准时间。
 */
function readLastPromptAt(ctx: any, session: any): number | undefined {
  try {
    const state = ctx.sessionProjections?.stateOf?.(session, 'sessionListMetadata')
    const value = state?.lastPromptAt
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}
