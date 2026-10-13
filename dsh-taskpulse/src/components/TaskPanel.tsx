/**
 * TaskPanel —— 展开面板（规范 3）。
 *
 * 尺寸 360x600，结构顺序严格按规范：
 *   AI TaskPulse（标题） → 任务统计 → 工作区列表 → 任务卡片
 *
 * 面板体只有一个视图：按工作区分组的任务列表，可按状态筛选。
 *
 * ⚠️ 早先这里有三个页签（任务 / 待确认 / 历史），用户明确要求删掉：
 * 「删除「运行、确认、完成、异常」四个按钮下方的那三个按钮（任务、待确认、
 * 历史），删除后该区域只保留这四个按钮」。
 * 因此 `Tab` 类型与 `tab` 状态一并移除，筛选完全由统计胶囊承担。
 *
 * 影响与取舍（如实记录，不假装没有）：
 *   - `ConfirmCard` 仍有入口：WAIT_CONFIRM 的任务点进详情视图就会渲染它，
 *     统计胶囊上的「确认」也能一键筛出这些任务。
 *   - `HistoryCard` 目前**没有入口**了。组件本身按规范 11 保留在代码库中
 *     （规范要求「组件存在」，不是「必须有页签」），但归档记录暂时无法查看。
 *     这是用户该次要求的直接后果，若需要回看历史，应另择入口而非恢复页签。
 */

import { useMemo, useState, type CSSProperties, type ReactElement } from 'react'
import type { HistoryItem, TaskDetail, WorkspaceGroupView } from '../models'
import { TASK_STATUS, addToCounts, emptyCounts, formatRelativeTime } from '../models'
import { WorkspaceGroup } from './WorkspaceGroup'
import { TaskDetailView } from './TaskDetail'

export interface TaskPanelProps {
  workspaces: WorkspaceGroupView[]
  tasks: TaskDetail[]
  history: HistoryItem[]
  now: number
  hostOnline: boolean
  onClose: () => void
  onRefresh: () => void
  /** 跳回会话（只读插件不代用户确认）。 */
  onOpenSession?: (sessionId: string) => void
  /** 当前选中的会话（详情视图）。 */
  selected?: string | null
  onSelect?: (sessionId: string | null) => void
  /**
   * 面板定位与尺寸上限（由 usePanelGeometry 按胶囊实时位置算出）。
   *
   * 面板是绝对定位的，位置不能写死在 CSS 里：胶囊可被拖到窗口任意位置，
   * 而 600px 高的面板固定向下展开会在胶囊位于下半屏时被窗口裁掉。
   */
  panelStyle?: CSSProperties
}

/**
 * 任务列表的状态筛选。
 *
 * 用户要求：「任务列表要可以切换显示，进行中、待确认、完成、异常，
 * 来准确查找需要的」。列表默认按工作区分组，当任务多起来时，
 * 想找「那个异常的」或「还在跑的」要一层层翻；筛选把这项工作变成一次点击。
 *
 * ⚠️ 筛选**不是**新增一行按钮：规范 3 的第二段「任务统计」本来就有一排
 * 状态胶囊（运行/确认/完成/异常/阻塞），再添一行同名按钮纯属重复。
 * 这里直接让那排统计胶囊可点击 —— 它已经是用户眼里的「那几个按钮」了。
 *
 * 出口同样只有这一排本身：**再点一次已选中的胶囊**即取消筛选。不另设
 * 「全部」按钮 —— 它会在末尾多出一枚，用户已明确要求去掉。
 *
 * 口径：每个筛选恰好对应一个统计计数（`addToCounts` 的分桶方式），
 * 所以胶囊上的数字就是点下去能看到的条数。
 * 例外只有 `running`：它同时涵盖 RUNNING 与 START（`addToCounts` 也这么分桶），
 * 因为「待开始」在用户眼里同样是「还没跑完」。
 */
export type TaskFilter = 'all' | 'running' | 'waitConfirm' | 'success' | 'error' | 'blocked'

export const TASK_FILTER_LABEL: Record<TaskFilter, string> = {
  all: '全部',
  running: '进行中',
  waitConfirm: '待确认',
  success: '完成',
  error: '异常',
  blocked: '阻塞'
}

/** 判定一条任务是否命中筛选。 */
export function matchesFilter(task: Pick<TaskDetail, 'status'>, filter: TaskFilter): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return task.status === TASK_STATUS.RUNNING || task.status === TASK_STATUS.START
    case 'waitConfirm':
      return task.status === TASK_STATUS.WAIT_CONFIRM
    case 'success':
      return task.status === TASK_STATUS.SUCCESS
    case 'error':
      // 只认 ERROR。阻塞有自己的一枚胶囊，混进来会让「异常 3」点开却是 4 条。
      return task.status === TASK_STATUS.ERROR
    case 'blocked':
      return task.status === TASK_STATUS.BLOCKED
    default:
      return true
  }
}

/**
 * 统计胶囊的定义：emoji + 文案 + 语义色 + 它对应的筛选。
 *
 * 顺序沿用 UI 规范与原型（运行 / 确认 / 完成 / 异常），阻塞排在最后，
 * 且只在真的有阻塞任务时才出现 —— 平时不占位置。
 */
const STAT_PILLS: ReadonlyArray<{ key: TaskFilter; icon: string; label: string; tone: string }> = [
  { key: 'running', icon: '🟦', label: '运行', tone: 'blue' },
  { key: 'waitConfirm', icon: '🟡', label: '确认', tone: 'yellow' },
  { key: 'success', icon: '🟢', label: '完成', tone: 'green' },
  { key: 'error', icon: '🔴', label: '异常', tone: 'red' },
  { key: 'blocked', icon: '🟠', label: '阻塞', tone: 'orange' }
]

export function TaskPanel(props: TaskPanelProps): ReactElement {
  // `history` 仍留在 props（调用方继续喂数据，接口不变），但不再被渲染：
  // 显示它的那个页签已按用户要求删除。保留 prop 是为了日后另择入口时
  // 不必再改签名与调用方。
  const { workspaces, tasks, now, hostOnline, onClose, onRefresh } = props
  const [filter, setFilter] = useState<TaskFilter>('all')
  const [localSelected, setLocalSelected] = useState<string | null>(null)
  const selected = props.selected !== undefined ? props.selected : localSelected
  const setSelected = props.onSelect ?? setLocalSelected

  const selectedTask = selected === null ? undefined : tasks.find((task) => task.sessionId === selected)

  // 筛选后的任务：分组与统计都基于这一份，保证「看到的」与「数字」一致。
  const visibleTasks = useMemo(
    () => (filter === 'all' ? tasks : tasks.filter((task) => matchesFilter(task, filter))),
    [tasks, filter]
  )
  // 统计胶囊上的数字。与 `visibleTasks` 用同一个 `matchesFilter`，
  // 因此「胶囊写 3」与「点开后 3 条」在实现上不可能不一致。
  const filterCounts = useMemo(() => {
    const counts: Record<TaskFilter, number> = {
      all: tasks.length,
      running: 0,
      waitConfirm: 0,
      success: 0,
      error: 0,
      blocked: 0
    }
    for (const task of tasks) {
      for (const pill of STAT_PILLS) {
        if (matchesFilter(task, pill.key)) counts[pill.key] += 1
      }
    }
    return counts
  }, [tasks])

  // 详情视图：取代列表，但保留面板外壳与底栏（保证交互一致性）。
  // 面板体只剩这两种形态（原先的「确认中心 / 历史」两页随页签一并删除）。
  const body = selectedTask !== undefined
    ? (
        <TaskDetailView
          task={selectedTask}
          now={now}
          onBack={() => setSelected(null)}
          onOpen={props.onOpenSession}
        />
      )
    : visibleTasks.length === 0
      ? (
          <div className="tp-empty">
            <span className="tp-empty-icon" aria-hidden="true">🔍</span>
            {tasks.length === 0
              ? '暂无活跃任务\n有会话开始执行时会自动出现'
              : `没有「${TASK_FILTER_LABEL[filter]}」状态的任务`}
          </div>
        )
      : (
          <TaskListView workspaces={workspaces} tasks={visibleTasks} now={now} onSelect={setSelected} filtered={filter !== 'all'} />
        )

  return (
    <div className="tp-panel" role="dialog" aria-label="AI TaskPulse 任务面板" style={props.panelStyle}>
      <div className="tp-panel-header">
        <div>
          <div className="tp-panel-title">AI TaskPulse</div>
          <div className="tp-panel-sub">
            {hostOnline ? '多工作区任务监控中' : '宿主半边离线 · 仅本地状态'} · {formatRelativeTime(now, now)}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 2 }}>
          <button type="button" className="tp-icon-btn" onClick={onRefresh} title="立即刷新" aria-label="立即刷新">
            ⟳
          </button>
          <button type="button" className="tp-icon-btn" onClick={onClose} title="收起面板" aria-label="收起面板">
            ✕
          </button>
        </div>
      </div>

      {/* 任务统计（规范 3 第二段）——这一排同时就是状态筛选。
          点「🔴 异常 1」即只看异常，**再点同一枚**即回到全部。
          出口刻意只有这一个：早先在筛选生效时会在末尾追加一枚「✕ 全部 N」，
          但用户明确要求去掉（「点击任意一个时，选项末尾会多出一个『全部』」），
          一排里只有状态胶囊，没有第六枚按钮。
          数字与筛选共用 `matchesFilter`，所以「写着 3」点开必定是 3 条。
          它同时也是这一区域**唯一的**一排按钮（原先下方的三个页签已按
          用户要求删除），因此筛选无结果时它必定还在，能点回来。 */}
      <div className="tp-stats" role="group" aria-label="按状态筛选任务">
        {STAT_PILLS.map((pill) => {
          const count = filterCounts[pill.key]
          // 阻塞平时不占位置：没有阻塞任务时这枚胶囊不存在。
          if (pill.key === 'blocked' && count === 0) return null
          const active = filter === pill.key && selectedTask === undefined
          return (
            <button
              key={pill.key}
              type="button"
              className="tp-stat"
              data-tone={pill.tone}
              aria-pressed={active}
              disabled={count === 0}
              title={active ? `取消筛选，显示全部 ${tasks.length} 个任务` : `只看「${pill.label}」的任务（${count}）`}
              onClick={() => {
                // 正在看详情时先退回列表，否则点了没有反馈。
                setSelected(null)
                setFilter(active ? 'all' : pill.key)
              }}
            >
              <span aria-hidden="true">{pill.icon}</span>
              {pill.label} {count}
            </button>
          )
        })}
      </div>

      <div className="tp-body">{body}</div>

      <div className="tp-footer">
        <span className="tp-footer-hint">
          共 {tasks.length} 个活跃任务 · {workspaces.length} 个工作区
        </span>
        <button
          type="button"
          className="tp-footer-btn"
          onClick={() => setSelected(null)}
        >
          查看全部任务 ›
        </button>
      </div>
    </div>
  )
}

/** 任务列表：按工作区分组渲染（规范 4/5）。 */
function TaskListView({
  workspaces,
  tasks,
  now,
  onSelect,
  filtered = false
}: {
  workspaces: WorkspaceGroupView[]
  tasks: TaskDetail[]
  now: number
  onSelect: (sessionId: string) => void
  /** 筛选态（filter !== 'all'）下，某工作区没有命中任务就整组不显示。 */
  filtered?: boolean
}): ReactElement {
  if (tasks.length === 0) {
    return (
      <div className="tp-empty">
        <span className="tp-empty-icon" aria-hidden="true">🌙</span>
        当前没有正在执行的任务
        <br />
        发起一次对话后，执行状态会实时出现在这里
      </div>
    )
  }

  const byWorkspace = new Map<string, TaskDetail[]>()
  for (const task of tasks) {
    const key = task.workspaceId ?? '__default__'
    const bucket = byWorkspace.get(key)
    if (bucket === undefined) byWorkspace.set(key, [task])
    else bucket.push(task)
  }

  // 宿主给的工作区分组优先；未在其中的任务用兜底分组展示，保证不丢任务。
  const rendered = new Set<string>()
  const groups: ReactElement[] = []
  for (const workspace of workspaces) {
    const items = byWorkspace.get(workspace.id) ?? []
    // 筛选态：`tasks` 已经是筛过的（visibleTasks），items 为空即该工作区
    // 在当前筛选下没有任务 —— 整组不渲染，而不是渲染一个「暂无活跃任务」。
    // all 视图维持原判（items 空且工作区没有会话才跳过），保留空组让用户
    // 看到工作区仍然存在。
    if (items.length === 0 && (filtered || workspace.conversationCount === 0)) continue
    rendered.add(workspace.id)
    groups.push(
      <WorkspaceGroup
        key={workspace.id}
        workspace={workspace}
        tasks={items}
        now={now}
        onSelect={onSelect}
      />
    )
  }
  for (const [key, items] of byWorkspace) {
    if (rendered.has(key)) continue
    // 兜底分组：直接交给 WorkspaceGroup 渲染，**不要**在外面再套一层 .tp-group。
    // 早先这里多包了一层，于是「未归类会话」出现两层标题与两个边框 ——
    // 外层是手写的标题行，内层是 WorkspaceGroup 自己的标题行。
    groups.push(
      <WorkspaceGroup
        key={key}
        workspace={{
          id: key,
          name: key === '__default__' ? '未归类会话' : key,
          path: '',
          conversationCount: items.length,
          counts: (() => {
            let counts = { running: 0, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 0 }
            for (const task of items) counts = addToCounts(counts, task.status)
            return counts
          })(),
          updatedAt: now
        }}
        tasks={items}
        now={now}
        onSelect={onSelect}
      />
    )
  }
  return <>{groups}</>
}

export default TaskPanel
