/**
 * DSH TaskPulse —— 浏览器半边入口（规范三 §1/§2：src/client）。
 *
 * 挂载点：`shell.overlay`（由 dsh-client-ui-layout 的 root 条目声明的
 * list 插槽，scope="root"）。这是 DSH 官方给「全局右上角浮层」预留的位置：
 *   - 层本身 `pointer-events: none`，子项自动恢复点击 ⇒ 绝不遮挡聊天区；
 *   - 通过 `--dsh-frame-overlay-top` 自动避让 macOS/Windows 标题栏与全屏。
 *
 * 数据来源（双路，见 store/client-store.ts）：
 *   1. root 标准 props：useSessions / useSessionStatus / useWorkspaces
 *      —— 由 dsh-client-ui-session、-workspace 通过 provideRoot 贡献，
 *      零延迟给出「哪些会话在跑 / 哪个在等确认」；
 *   2. 宿主半边 HTTP 快照：`/api/dsh-taskpulse/snapshot`
 *      —— 补齐浏览器半边拿不到的 Timeline、当前步骤、工具调用数。
 *
 * ⚠️ 加载契约（两处极易踩坑，已在 build-client.mjs 与 package.json 对齐）：
 *   - 本文件导出的是 **Cordis 服务名** `['slots']`，而 package.json 里
 *     `dsh.client.inject` 填的是 **包名**（@deepseek-ai/dsh-client-ui-layout …）；
 *   - bundle 必须由 `window.__ModuleLoader__.load({id, factory})` 包裹，
 *     id 等于包名。缺 inject 时 `ctx.slots` 的代理 getter 会沿 fiber 父链抛
 *     `cannot get property "slots" without inject`，整个插件 fiber 直接 FAILED。
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { TaskButton } from '../components/TaskButton'
import { TaskPanel } from '../components/TaskPanel'
import { useHostData } from '../hooks/use-host-data'
import { useCapsuleDrag } from '../hooks/use-capsule-drag'
import { usePanelGeometry } from '../hooks/use-panel-geometry'
import {
  buildViewModel,
  type SessionRowLike,
  type SessionStatusLike,
  type WorkspaceViewLike
} from '../store/client-store'
import { ensureStyles } from '../styles/taskpulse-css'

/** 插槽键（layout 的 root 条目声明）。 */
const SLOT = 'shell.overlay'

/** 条目 id（list 插槽必填，参与去重与回收）。 */
const ENTRY_ID = 'taskpulse.overlay'

/** 标准 hooks 的读取签名。 */
type Selector<T, R> = (snapshot: T) => R

interface SessionsSnapshotLike {
  ids?: string[]
  byId?: Record<string, SessionRowLike>
}

interface WorkspacesSnapshotLike {
  items?: WorkspaceViewLike[]
  /** 归档会话账本（`WorkspaceBaseline` 字段，宿主 registry 全局集合）。 */
  archivedSessionIds?: string[]
}

/** 渲染器注入到 shell.overlay 条目的 props（root 标准 props + 本插件自有 props）。 */
export interface TaskPulseOverlayProps {
  useSessions?: <R>(selector: Selector<SessionsSnapshotLike, R>) => R
  useSessionStatus?: <R>(selector: Selector<Map<string, SessionStatusLike>, R>) => R
  useWorkspaces?: <R>(selector: Selector<WorkspacesSnapshotLike, R>) => R
  [key: string]: unknown
}

/**
 * 右上角浮窗：默认胶囊入口，点击展开 360x600 面板。
 */
export function TaskPulseOverlay(props: TaskPulseOverlayProps): ReactElement {
  const [expanded, setExpanded] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const rootRef = useRef<HTMLDivElement | null>(null)

  // ---- 第一路：root 标准 props（选择器保持稳定引用，避免额外重渲染） ----
  const ids = props.useSessions?.((snapshot) => snapshot?.ids)
  const byId = props.useSessions?.((snapshot) => snapshot?.byId)
  const statuses = props.useSessionStatus?.((snapshot) => snapshot)
  const workspaceItems = props.useWorkspaces?.((snapshot) => snapshot?.items)
  const archivedSessionIds = props.useWorkspaces?.((snapshot) => snapshot?.archivedSessionIds)

  const sessions = useMemo<SessionRowLike[]>(() => {
    if (ids === undefined || ids.length === 0) return []
    const out: SessionRowLike[] = []
    for (const id of ids) {
      const row = byId?.[id]
      if (row !== undefined) out.push(row)
    }
    return out
  }, [ids, byId])

  // ---- 第二路：宿主半边快照（面板收起时暂停轮询，进一步降低打扰） ----
  const { snapshot, history, refresh } = useHostData(expanded)

  const view = useMemo(
    () =>
      buildViewModel({
        snapshot,
        sessions,
        statuses,
        workspaces: workspaceItems ?? [],
        archivedSessionIds: archivedSessionIds ?? [],
        history
      }),
    [snapshot, sessions, statuses, workspaceItems, archivedSessionIds, history]
  )

  // ---- 相对时间 / 运行耗时每秒刷新（不改动任何数据源） ----
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])

  // ---- 点击面板与入口之外收起（Esc 同样收起），保证不长期占据右上角 ----
  useEffect(() => {
    if (!expanded) return undefined
    const onPointerDown = (event: MouseEvent) => {
      const node = rootRef.current
      if (node !== null && !node.contains(event.target as Node)) setExpanded(false)
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setExpanded(false)
    }
    document.addEventListener('mousedown', onPointerDown)
    document.addEventListener('keydown', onKeyDown)
    return () => {
      document.removeEventListener('mousedown', onPointerDown)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [expanded])

  const toggle = useCallback(() => setExpanded((value) => !value), [])
  const close = useCallback(() => setExpanded(false), [])

  // ---- 胶囊拖动：收起态可拖，展开态不接管（避免与面板滚动冲突） ----
  const drag = useCapsuleDrag({ rootRef, enabled: !expanded })

  // ---- 面板定位：按「胶囊实时位置 + 窗口可用空间」算位置与尺寸上限 ----
  // 胶囊可被拖到窗口任意位置，而面板高 600px。固定向下展开时，只要胶囊在下半屏，
  // 面板就会伸出内容区被 layout frame 的 overflow:hidden 裁掉（滚动救不回来，
  // 因为裁切发生在滚动容器之外）。这里让面板能翻到胶囊上方，并在空间不足时压缩高度。
  const panel = usePanelGeometry(rootRef, expanded)

  /** 拖动过就不该顺带展开/收起 —— 吞掉拖动结束时的那次 click。 */
  const onToggleClick = useCallback(() => {
    if (drag.consumeDrag()) return
    toggle()
  }, [drag, toggle])

  return (
    <div className="tp-root" ref={rootRef} style={drag.style} data-dragging={drag.dragging || undefined}>
      <TaskButton
        count={view.stats.total}
        stats={view.stats}
        expanded={expanded}
        onToggle={onToggleClick}
        dragHandlers={drag.handleProps}
        dragging={drag.dragging}
        draggable={!expanded}
      />
      {expanded && (
        <TaskPanel
          panelStyle={panel.style}
          workspaces={view.workspaces}
          tasks={view.tasks}
          history={view.history}
          now={now}
          hostOnline={view.hostOnline}
          onClose={close}
          onRefresh={refresh}
        />
      )}
    </div>
  )
}

/** Cordis 服务名（**不是**包名）。 */
export const inject = ['slots']

export const name = 'dsh-taskpulse'

/**
 * 插件入口。
 *
 * 必须走 `ctx.slots.inject(键, () => ctx.slots.register(...))`：
 * slot 由父条目（layout 的 root）在 children 里声明，声明顺序不保证，
 * 直接 register 未声明的槽位会在加载时抛 `slot "X" is not declared`。
 */
export function apply(ctx: any): void {
  ensureStyles()
  ctx.slots.inject(SLOT, () =>
    ctx.slots.register(
      {
        name: SLOT,
        id: ENTRY_ID,
        order: 100,
        label: 'AI TaskPulse'
      },
      TaskPulseOverlay
    )
  )
}

export default { name, inject, apply }
