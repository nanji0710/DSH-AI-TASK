/**
 * 插槽标准 props 与 owner props 的类型声明。
 *
 * `shell.overlay` 是 scope="root" 的 list 插槽，其条目**白拿**一组标准 props
 * （由 dsh-client-ui-session / -workspace / -layout / dsh-client-resources 通过
 * `ctx.slots.provideRoot({ hooks, keyedHooks })` 贡献）。命名规则：
 * `standardHookPropName(name) = 'use' + name[0].toUpperCase() + name.slice(1)`。
 *
 * 官方 root 标准 hooks（本插件用到的）：
 *   useSessions    → 会话目录（ids / byId / phase / projectionsBySession）
 *   useSessionStatus → Map<sessionId, { running?, pendingInteraction?, completionUnread }>
 *   useWorkspaces  → 工作区列表（items / archivedSessionIds / pinnedSessionIds）
 *   usePanelInfo   → 布局面板信息
 *   useResource(key) → 资源源
 *
 * ⚠️ 这些 props 由渲染器注入，**不需要**（也无法）通过 `inject` 声明。
 */

import type { SessionRowLike, SessionStatusLike, WorkspaceViewLike } from '../store/client-store'

/** `useSessions(selector)` 的快照形状。 */
export interface SessionsSnapshot {
  ids: string[]
  byId: Record<string, SessionRowLike>
  phase?: string
  projectionsBySession?: Record<string, unknown>
}

/** `useWorkspaces(selector)` 的快照形状。 */
export interface WorkspacesSnapshot {
  items: WorkspaceViewLike[]
  archivedSessionIds?: string[]
  pinnedSessionIds?: string[]
  state?: string
  phase?: string
  error?: unknown
}

/** 标准 hooks 的读取签名（selector 必须返回稳定引用，必要时传 isEqual）。 */
export type StandardHook<T> = <R>(selector: (snapshot: T) => R, isEqual?: (a: R, b: R) => boolean) => R

/** `shell.overlay` 条目的 props：标准 props + register 的 `inject()` 返回值。 */
export interface OverlayProps {
  useSessions?: StandardHook<SessionsSnapshot>
  useSessionStatus?: StandardHook<Map<string, SessionStatusLike>>
  useWorkspaces?: StandardHook<WorkspacesSnapshot>
  usePanelInfo?: StandardHook<unknown>
  useResource?: (key: unknown) => unknown
  /** 本插件通过 `register({ inject: () => ({...}) })` 注入的 props。 */
  [key: string]: unknown
}
