/**
 * 浏览器半边任务仓库（规范 5 事件流第三段「Task Store」的客户端部分）。
 *
 * 数据来源是**双路合并**：
 *   1. 宿主半边的快照（`/api/dsh-taskpulse/snapshot`）——提供 Timeline、当前
 *      步骤、工具调用数等浏览器半边拿不到的信息；
 *   2. 插槽标准 props（`useSessions` / `useSessionStatus` / `useWorkspaces`）
 *      ——提供零延迟的会话运行态与工作区目录，即使宿主半边不可达也有效。
 *
 * 合并策略：宿主快照优先（信息更全），标准 props 补齐宿主尚未覆盖的会话；
 * 合并之后还要过三道**口径关**，否则列表会与 DSH 侧栏对不上（用户报告过
 * 「一整屏待开始」与「侧栏 15 条、任务 20 条」）：
 *   - 归档关：`archivedSessionIds` 里的会话不算活跃任务。
 *     `useSessions` 的会话列表**不排除归档会话**（宿主
 *     `dsh-api-session-controller/lib/index.js:1888-1906 list()` 不做过滤），
 *     过滤是侧栏在客户端做的（`dsh-client-ui-workspace/lib/client.js:357-367
 *     sessionVisible()`）。插件缺这道过滤，于是把归档会话也算成活跃任务 ——
 *     这正是「侧栏 15 条、任务 20 条」的全部差额。
 *   - 状态关：非运行、非待确认的会话一律收敛为 SUCCESS，**绝不合成 START**
 *     ——「待开始」只对「本进程内刚建立、还没收到任何事件」的任务成立，
 *     历史会话早已跑完，把它判成「待开始」是把未知当成了未开始。
 *   - 归属关：工作区归属在合成任务的那一刻就写入，不能留给事后认领
 *     （事后认领只在宿主聚合缺失时才跑，等于永远不跑）。
 */

import type { TaskDetail, TaskStatus, WorkspaceGroupView, StatusCounts, HistoryItem } from '../models'
import { TASK_STATUS, addToCounts, emptyCounts } from '../models'
import { fetchSnapshot, fetchHistory, emptyStats, type HostSnapshot } from '../services/client-api'

/** 会话行（`useSessions` 的 byId 值）。 */
export interface SessionRowLike {
  id: string
  displayTitle?: string
  title?: string
  running?: boolean
  blank?: boolean
  updatedAt?: number
  parentId?: string
  origin?: string
  cwd?: string
  projectionValues?: Record<string, unknown>
}

/** 会话状态（`useSessionStatus` 的值）。 */
export interface SessionStatusLike {
  running?: boolean
  pendingInteraction?: unknown
  completionUnread?: boolean
}

/** 工作区视图（`useWorkspaces` 的 items 元素）。 */
export interface WorkspaceViewLike {
  workspaceId: string
  path: string
  title: string
  sessionIds: string[]
  createdAt?: string
  updatedAt?: string
}

/** 双路合并后的完整视图模型。 */
export interface TaskPulseViewModel {
  stats: StatusCounts
  workspaces: WorkspaceGroupView[]
  tasks: TaskDetail[]
  history: HistoryItem[]
  /** 是否有异常任务（入口闪红）。 */
  hasError: boolean
  /** 宿主半边是否可达。 */
  hostOnline: boolean
}

/** 把标准 props 的产物合并成统一视图。 */
export function buildViewModel(input: {
  snapshot: HostSnapshot | null
  sessions: SessionRowLike[]
  statuses: Map<string, SessionStatusLike> | undefined
  workspaces: WorkspaceViewLike[]
  archivedSessionIds?: string[]
  history: HistoryItem[]
}): TaskPulseViewModel {
  const { snapshot, sessions, statuses, workspaces, history } = input
  const archived = new Set(input.archivedSessionIds ?? [])
  const tasks = new Map<string, TaskDetail>()

  // 会话 id → 工作区 id。DSH 的归属关系就挂在 `WorkspaceView.sessionIds` 上，
  // 合成任务时必须当场查表写入；留给「事后认领」等于永远不认领。
  const owner = new Map<string, string>()
  for (const workspace of workspaces) {
    for (const sessionId of workspace.sessionIds ?? []) {
      if (!owner.has(sessionId)) owner.set(sessionId, workspace.workspaceId)
    }
  }

  // ---- 第一路：宿主快照（信息最全） ----
  for (const detail of Object.values(snapshot?.details ?? {})) {
    if (archived.has(detail.sessionId)) continue // 已归档不属于活跃任务
    tasks.set(detail.sessionId, detail)
  }

  // ---- 第二路：标准 props 补齐宿主未覆盖的会话 ----
  for (const row of sessions) {
    if (row.blank === true) continue // 空会话不占任务列表
    if (row.origin === 'subagent') continue // 子代理会话归入其父会话，不单列
    if (archived.has(row.id)) continue // 已归档：与侧栏口径一致
    if (tasks.has(row.id)) {
      // 宿主已有该任务：用标准 props 校正运行态（它是权威信号，零延迟）。
      const existing = tasks.get(row.id)!
      const status = statuses?.get(row.id)
      applyPendingInteraction(existing, status)
      if (status?.running === true && existing.status !== TASK_STATUS.WAIT_CONFIRM) {
        existing.status = TASK_STATUS.RUNNING
      }
      if (row.displayTitle !== undefined && row.displayTitle.length > 0) existing.title = row.displayTitle
      if (existing.workspaceId === null) existing.workspaceId = owner.get(row.id) ?? null
      continue
    }
    const status = statuses?.get(row.id)
    const running = status?.running === true || row.running === true
    const pending = status?.pendingInteraction !== undefined
      && status?.pendingInteraction !== null
      && isLiveInteraction(status.pendingInteraction)
    // 状态收敛：只有「正在跑」和「等确认」是活动态；其余一律 SUCCESS。
    // 这里**绝不能**回落到 START —— START 的语义是「本进程内刚建立、尚未收到
    // 任何事件」，而这里面对的是已经存在（很可能早已结束）的历史会话。
    const resolved: TaskStatus = pending
      ? TASK_STATUS.WAIT_CONFIRM
      : running
        ? TASK_STATUS.RUNNING
        : TASK_STATUS.SUCCESS
    tasks.set(row.id, synthesizeTask(row, resolved, owner.get(row.id) ?? null))
  }

  // ---- 工作区分组（宿主聚合优先；缺失时用标准 props 现场聚合） ----
  const grouped = snapshot?.workspaces !== undefined && snapshot.workspaces.length > 0
    ? snapshot.workspaces.map((workspace) => ({
        ...workspace,
        counts: recount(workspace.id, tasks)
      }))
    : synthesizeWorkspaces(workspaces, tasks, archived)

  // ---- 统计 ----
  // 一律按合并后的任务重算，**不采用宿主快照的 stats**：那一份是宿主在扣归档
  // 之前算的，而列表已经扣过。直接照搬会让「完成 18」与列表里的 15 张卡片打架
  // —— 用户报告的就是这类数字对不上。
  let stats = emptyCounts()
  for (const task of tasks.values()) stats = addToCounts(stats, task.status)

  return {
    stats,
    workspaces: grouped.sort((a, b) => b.updatedAt - a.updatedAt),
    tasks: [...tasks.values()].sort(compareTasks),
    history,
    hasError: stats.error > 0,
    hostOnline: snapshot !== null
  }
}

/**
 * 用标准 props 的 `pendingInteraction` 校正一条**宿主已建档**任务的状态。
 *
 * 宿主半边的判定是事件驱动的（`approval/asked`、`ask_user_question` 的 tool/call），
 * 而浏览器半边还握有一份官方聚合出来的「待处理交互」权威信号
 * （`useSessionStatus().get(id).pendingInteraction`，由
 * `dsh-client-ui-session/lib/client.js:299-312` 按域优先级聚合）。两者互补：
 * 宿主负责语义判定，这里负责零延迟与兜底。
 *
 * **必须双向**：挂起时提升为「待确认」，挂起消失时回落 —— 只提升不回落会让
 * 状态永久卡在「待确认」，比不修还糟。
 * - 提升：任务不是终态才算「在等」。已完成的会话若还挂着一张可回看的提问卡
 *   （`dsh-client-ui-tool/lib/client.js:2265` 的「查看」入口会重建只读卡，
 *   `PendingQuestion.review` 非空即属此类），那不是「等你处理」，不应翻回待确认。
 * - 回落：只在还停在 WAIT_CONFIRM 时动，且只在会话确实还在跑时回 RUNNING；
 *   会话已经不在跑，就交给宿主的事件流去决定终态，客户端不猜。
 */
function applyPendingInteraction(task: TaskDetail, status: SessionStatusLike | undefined): void {
  const pending = status?.pendingInteraction
  const interactive = pending !== undefined && pending !== null && isLiveInteraction(pending)
  if (interactive) {
    if (!isTerminalTaskStatus(task.status)) task.status = TASK_STATUS.WAIT_CONFIRM
    return
  }
  if (task.status === TASK_STATUS.WAIT_CONFIRM && status?.running === true) {
    task.status = TASK_STATUS.RUNNING
  }
}

/** 只读回看卡不算「等你处理」：`review` 有值表示这次提问早已结束。 */
function isLiveInteraction(pending: unknown): boolean {
  const review = (pending as { review?: unknown } | null)?.review
  return review === undefined || review === null
}

/** 终态（与宿主 `TaskStore.applyRunning` 的判定一致）。 */
function isTerminalTaskStatus(status: TaskStatus): boolean {
  return status === TASK_STATUS.SUCCESS
    || status === TASK_STATUS.ERROR
    || status === TASK_STATUS.BLOCKED
}

/** 宿主未覆盖的会话：用最小信息合成一张任务卡（无 Timeline）。 */
function synthesizeTask(row: SessionRowLike, status: TaskStatus, workspaceId: string | null): TaskDetail {
  const now = Date.now()
  const title = row.displayTitle ?? row.title ?? row.id.slice(0, 12)
  // `row.updatedAt` 的语义是「该会话最后一条真实用户消息时间」
  // （宿主 `updatedAt(header, metadata) = max(createdAt, lastPromptAt)`，
  // 见 dsh-api-session-controller/lib/index.js:2040-2042），
  // 因此它在**该对话正在运行时**恰好等于本轮起点，可以安全用作 runStartedAt。
  const observed = row.updatedAt ?? now
  const active = status === TASK_STATUS.RUNNING || status === TASK_STATUS.WAIT_CONFIRM
  return {
    id: row.id,
    sessionId: row.id,
    // 归属当场写入（来自 `WorkspaceView.sessionIds`）；查不到才允许为 null，
    // 那时列表会把它放进「未归类会话」并如实计数。
    workspaceId,
    title,
    status,
    progress: status === TASK_STATUS.SUCCESS ? 1 : status === TASK_STATUS.RUNNING ? 0.3 : 0,
    currentStep: status === TASK_STATUS.RUNNING ? '执行中' : null,
    currentDetail: null,
    agent: readAgentName(row),
    model: null,
    startedAt: observed,
    // 只在「正在跑」时给出起点；已结束的任务无从得知本轮起止，
    // 宁可 null（UI 显示 `—`）也不拿用户消息时间冒充运行时长。
    runStartedAt: active ? observed : null,
    lastActionTime: observed,
    finishedAt: status === TASK_STATUS.SUCCESS ? observed : null,
    turn: 0,
    step: 0,
    toolCalls: 0,
    steps: 0,
    error: null,
    pendingConfirm: null,
    timeline: []
  }
}

/** 从投影里读 Agent 名（官方读法：projectionValues.agentPreset）。 */
function readAgentName(row: SessionRowLike): string | null {
  const preset = row.projectionValues?.agentPreset
  if (typeof preset === 'string' && preset.length > 0) return preset
  return null
}

/** 用实际任务重算某个工作区的状态计数（宿主那份是扣归档之前的，不能直接用）。 */
function recount(workspaceId: string, tasks: Map<string, TaskDetail>): StatusCounts {
  let counts = emptyCounts()
  for (const task of tasks.values()) {
    if (task.workspaceId === workspaceId) counts = addToCounts(counts, task.status)
  }
  // 不再有「匹配不到就信任宿主计数」的兜底：归属已在合成时逐条查表写入，
  // 匹配不到就是真的没有活跃任务。信任宿主会让组头数字与组内卡片数量打架。
  return counts
}

/** 宿主聚合缺失时的兜底：按工作区的 sessionIds 现场分组。 */
function synthesizeWorkspaces(
  workspaces: WorkspaceViewLike[],
  tasks: Map<string, TaskDetail>,
  archived: Set<string>
): WorkspaceGroupView[] {
  const out: WorkspaceGroupView[] = []
  const claimed = new Set<string>()
  for (const workspace of workspaces) {
    let counts = emptyCounts()
    let visible = 0
    for (const sessionId of workspace.sessionIds ?? []) {
      // 与侧栏同口径：归档会话不计入可见会话数。
      if (!archived.has(sessionId)) visible += 1
      const task = tasks.get(sessionId)
      if (task === undefined) continue
      // 归属在合成时已经定下（先声明的工作区胜出）。这里只认领与之一致的任务 ——
      // 若无条件改写，同一会话出现在两个工作区时会「谁在后面谁赢」，与
      // `owner` 表的判定相反，归属会随 map 顺序抖动。
      if (task.workspaceId === null) task.workspaceId = workspace.workspaceId
      if (task.workspaceId !== workspace.workspaceId) continue
      counts = addToCounts(counts, task.status)
      claimed.add(sessionId)
    }
    out.push({
      id: workspace.workspaceId,
      name: workspace.title || basename(workspace.path) || workspace.workspaceId,
      path: workspace.path,
      conversationCount: visible,
      counts,
      updatedAt: parseTime(workspace.updatedAt)
    })
  }
  // 未归属会话单独成组，保证「多工作区」验收标准在任意情况下都成立。
  let orphan = emptyCounts()
  for (const [sessionId, task] of tasks) {
    if (claimed.has(sessionId) || task.workspaceId !== null) continue
    orphan = addToCounts(orphan, task.status)
  }
  if (orphan.total > 0) {
    out.push({
      id: '__default__',
      name: '未归类会话',
      path: '',
      conversationCount: orphan.total,
      counts: orphan,
      updatedAt: Date.now()
    })
  }
  return out
}

/** 排序：异常 > 待确认 > 运行中 > 其他；同级按最近动作倒序。 */
const STATUS_WEIGHT: Record<TaskStatus, number> = {
  ERROR: 0,
  BLOCKED: 1,
  WAIT_CONFIRM: 2,
  RUNNING: 3,
  START: 4,
  SUCCESS: 5
}

function compareTasks(a: TaskDetail, b: TaskDetail): number {
  const weight = (STATUS_WEIGHT[a.status] ?? 9) - (STATUS_WEIGHT[b.status] ?? 9)
  if (weight !== 0) return weight
  return b.lastActionTime - a.lastActionTime
}

function basename(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

function parseTime(value: string | undefined): number {
  if (value === undefined) return 0
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/** 一次性拉取宿主数据（供 hook 调用）。 */
export async function loadHostData(signal?: AbortSignal): Promise<{
  snapshot: HostSnapshot | null
  history: HistoryItem[]
}> {
  const [snapshot, history] = await Promise.all([fetchSnapshot(signal), fetchHistory(signal)])
  return { snapshot, history: history ?? [] }
}

export { emptyStats }
