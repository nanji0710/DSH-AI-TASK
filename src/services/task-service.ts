/**
 * TaskService —— 规范 7 的五项核心接口实现（宿主侧）。
 *
 *   getWorkspaces()      → 工作区聚合视图（含状态计数）
 *   getConversations()   → 活跃会话任务列表
 *   getActiveTasks()     → 活跃任务字典
 *   updateTaskStatus()   → **只读插件**：仅允许内部归约调用（不对外暴露写入口）
 *   saveHistory()        → History 落盘
 *
 * 权限设计（规范 8）：允许 workspace.read / conversation.status.read /
 * task.read / timeline.read；禁止修改用户内容与自动执行操作。
 * 因此本服务的对外方法**全部是读**，唯一的写操作是把终态任务写进插件自己的
 * History 存档（不触碰用户内容）。
 */

import type { HistoryItem, TaskDetail, WorkspaceGroupView, StatusCounts } from '../models'
import { addToCounts, emptyCounts } from '../models'
import type { HistoryStore } from '../store/history-store'
import type { TaskStore } from '../store/task-store'

export interface TaskServiceDeps {
  ctx: any
  store: TaskStore
  history: HistoryStore
}

export class TaskService {
  private readonly ctx: any
  private readonly store: TaskStore
  private readonly history: HistoryStore

  constructor(deps: TaskServiceDeps) {
    this.ctx = deps.ctx
    this.store = deps.store
    this.history = deps.history
  }

  /** 规范接口 getActiveTasks()：会话 id → 任务详情的字典。 */
  getActiveTasks(): Record<string, TaskDetail> {
    return this.store.snapshotDetails()
  }

  /** 规范接口 getConversations()：活跃任务数组（按最近动作倒序）。 */
  getConversations(): TaskDetail[] {
    return Object.values(this.store.snapshotDetails()).sort((a, b) => b.lastActionTime - a.lastActionTime)
  }

  /**
   * 规范接口 getWorkspaces()：工作区聚合视图 + 状态计数（UI 规范 4）。
   *
   * ⚠️ 两个数字的口径必须分清（用户报告过「侧栏 15 个对话框、任务却显示 20 个」）：
   *   - `counts`：**本插件已建档的任务**按状态分布（活跃任务口径）；
   *   - `conversationCount`：该工作区在 DSH 侧栏里**可见的会话数** = 已注册
   *     sessionIds − 归档会话。侧栏的可见性判据是
   *     `dsh-client-ui-workspace/lib/client.js:357-367 sessionVisible()`，
   *     归档集合来自 `workspaceRegistry.archivedSessionIds`。
   * 早先 `conversationCount` 直接写 `counts.total`（插件任务数），于是它既不是
   * 侧栏数、也不扣归档 —— 两个口径混用，数字自然对不上。
   */
  getWorkspaces(): WorkspaceGroupView[] {
    const tasks = Object.values(this.store.snapshotDetails())
    const byWorkspace = new Map<string, {
      name: string
      path: string
      counts: StatusCounts
      conversationCount: number
      updatedAt: number
    }>()
    const archived = this.archivedSessionIds()

    // 先铺全部工作区（即使没有任务也要出现在列表里，规范 5）。
    for (const workspace of this.listWorkspaces()) {
      byWorkspace.set(workspace.id, {
        name: workspace.name,
        path: workspace.path,
        counts: emptyCounts(),
        conversationCount: workspace.sessionIds.filter((id) => !archived.has(id)).length,
        updatedAt: workspace.updatedAt
      })
    }

    for (const task of tasks) {
      const key = task.workspaceId ?? '__default__'
      let bucket = byWorkspace.get(key)
      if (bucket === undefined) {
        // 未归属到任何工作区的会话（如从任意目录新开的会话）单独成组。
        bucket = {
          name: task.workspaceId === null ? '未归类会话' : task.workspaceId,
          path: '',
          counts: emptyCounts(),
          conversationCount: 0,
          updatedAt: task.lastActionTime
        }
        byWorkspace.set(key, bucket)
      }
      bucket.counts = addToCounts(bucket.counts, task.status)
      bucket.updatedAt = Math.max(bucket.updatedAt, task.lastActionTime)
    }

    return [...byWorkspace.entries()]
      .map(([id, bucket]) => ({
        id,
        name: bucket.name,
        path: bucket.path,
        conversationCount: Math.max(bucket.conversationCount, bucket.counts.total),
        counts: bucket.counts,
        updatedAt: bucket.updatedAt
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  /** 规范接口 saveHistory()：把已归档任务持久化。 */
  async saveHistory(items: HistoryItem[]): Promise<void> {
    await this.history.saveAll(items)
  }

  /** 读取历史（UI 的 HistoryCard 数据源）。 */
  listHistory(): HistoryItem[] {
    return this.history.list()
  }

  /** 等待确认事项汇总（UI 规范 9 确认中心）。 */
  listPendingConfirms() {
    return this.store.pendingConfirms()
  }

  /** 顶层统计（UI 规范 3「任务统计」区块）。 */
  getStats(): StatusCounts {
    let counts = emptyCounts()
    for (const task of Object.values(this.store.snapshotDetails())) {
      counts = addToCounts(counts, task.status)
    }
    return counts
  }

  /**
   * 宿主工作区实体 → 视图（名称缺失时用路径末段兜底）。
   *
   * `sessionIds` 取的是工作区实体自己的 getter —— 它已经按
   * `sessionPath(id) === record.path` 过滤过（`dsh-workspace/lib/index.js:102-103`），
   * 因此这里的数组就是「属于该工作区的会话」，无需再做 cwd 比对。
   */
  private listWorkspaces(): Array<{ id: string; name: string; path: string; sessionIds: string[]; updatedAt: number }> {
    try {
      const list = this.ctx.workspaceRegistry?.list?.() ?? []
      return list.map((workspace: any) => {
        const path = String(workspace?.path ?? '')
        const title = typeof workspace?.title === 'string' && workspace.title.trim().length > 0
          ? workspace.title.trim()
          : basename(path) || String(workspace?.id ?? '工作区')
        const updatedAt = toEpoch(workspace?.updatedAt)
        const rawIds = workspace?.sessionIds
        const sessionIds = Array.isArray(rawIds) ? rawIds.map(String) : []
        return { id: String(workspace.id), name: title, path, sessionIds, updatedAt }
      })
    } catch {
      return []
    }
  }

  /**
   * 归档会话集合（registry 全局账本）。
   *
   * 注意归档**不会**把会话从 `workspace.sessionIds` 里摘掉 ——
   * `dsh-workspace/lib/index.js:231-233` 明确写着「an archived session keeps
   * its sessionIds slot（unarchiving must restore the position）」，
   * 所以想对齐侧栏的可见数就必须显式扣除。
   */
  private archivedSessionIds(): Set<string> {
    try {
      const raw = this.ctx.workspaceRegistry?.archivedSessionIds
      const list = raw instanceof Set ? [...raw] : raw
      if (!Array.isArray(list)) return new Set()
      return new Set(list.map(String))
    } catch {
      return new Set()
    }
  }
}

/** 路径末段（避免依赖 node:path，保持 model 层纯净）。 */
function basename(path: string): string {
  if (!path) return ''
  const normalized = path.replace(/[\\/]+$/, '')
  const index = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'))
  return index >= 0 ? normalized.slice(index + 1) : normalized
}

/** ISO 字符串 / 数字 时间戳 → epoch ms。 */
function toEpoch(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string') {
    const parsed = Date.parse(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return 0
}
