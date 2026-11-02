/**
 * WorkspaceGroup —— 工作区分组（规范 4 / 5）。
 *
 * 头部形如 `▸ DSH-AI-TASK` 后接状态统计 `完成 2 运行 1`；
 * 组内是任务卡片（或紧凑的会话条目）。
 *
 * 头部不再用 emoji：原先是文件夹贴纸 emoji + 彩色方块 emoji 拼的计数。
 * emoji 的形状/配色由系统字体决定，深色面板上它们比正文还跳，且数字在前
 * 的写法（如「2 运行」）也不通顺。现在文件夹是描边 SVG（currentColor，
 * 跟着主题走），计数统一写成「运行 2」——颜色仍由 data-tone 交给 CSS 处理。
 */

import type { ReactElement } from 'react'
import type { WorkspaceGroupView } from '../models'
import { TaskCard } from './TaskCard'
import { ConversationItem } from './ConversationItem'
import type { TaskDetail } from '../models'

export interface WorkspaceGroupProps {
  workspace: WorkspaceGroupView
  tasks: TaskDetail[]
  now: number
  onSelect?: (sessionId: string) => void
  /** 紧凑模式：只列会话条目，不展开卡片与 Timeline。 */
  compact?: boolean
}

/** 描边文件夹图标（13x13，颜色跟随 currentColor）。 */
function FolderIcon(): ReactElement {
  return (
    <svg className="tp-group-icon" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path
        d="M1.75 3.5h3.9l1.35 1.5h7.25v8.25a.75.75 0 0 1-.75.75H2.5a.75.75 0 0 1-.75-.75V3.5Z"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
    </svg>
  )
}

export function WorkspaceGroup({
  workspace,
  tasks,
  now,
  onSelect,
  compact = false
}: WorkspaceGroupProps): ReactElement {
  return (
    <div className="tp-group">
      <div className="tp-group-title">
        <FolderIcon />
        <span className="tp-group-title-name" title={workspace.path || workspace.name}>
          {workspace.name}
        </span>
        <span className="tp-group-counts">
          {workspace.counts.running > 0 && <span data-tone="blue">运行 {workspace.counts.running}</span>}
          {workspace.counts.waitConfirm > 0 && <span data-tone="yellow">确认 {workspace.counts.waitConfirm}</span>}
          {workspace.counts.error > 0 && <span data-tone="red">异常 {workspace.counts.error}</span>}
          {workspace.counts.blocked > 0 && <span data-tone="orange">阻塞 {workspace.counts.blocked}</span>}
          {workspace.counts.success > 0 && <span data-tone="green">完成 {workspace.counts.success}</span>}
        </span>
      </div>

      {tasks.length === 0 ? (
        <div className="tp-conv" style={{ opacity: 0.6 }}>
          暂无活跃任务
        </div>
      ) : compact ? (
        tasks.map((task) => <ConversationItem key={task.sessionId} task={task} now={now} onSelect={onSelect} />)
      ) : (
        // TaskCard 不再接收 `now`：列表已不渲染任何相对时间（耗时行删掉了）。
        tasks.map((task) => <TaskCard key={task.sessionId} task={task} onSelect={onSelect} />)
      )}
    </div>
  )
}

export default WorkspaceGroup
