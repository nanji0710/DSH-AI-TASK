/**
 * WorkspaceGroup —— 工作区分组（规范 4 / 5）。
 *
 * 头部形如 `📁 GoldPulse` 后接状态统计 `🟦2运行  🟡1确认`；
 * 组内是任务卡片（或紧凑的会话条目）。
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
        <span aria-hidden="true">📁</span>
        <span className="tp-group-title-name" title={workspace.path || workspace.name}>
          {workspace.name}
        </span>
        <span className="tp-group-counts">
          {workspace.counts.running > 0 && <span style={{ color: '#2563eb' }}>🟦{workspace.counts.running}运行</span>}
          {workspace.counts.waitConfirm > 0 && <span style={{ color: '#ca8a04' }}>🟡{workspace.counts.waitConfirm}确认</span>}
          {workspace.counts.error > 0 && <span style={{ color: '#dc2626' }}>🔴{workspace.counts.error}异常</span>}
          {workspace.counts.blocked > 0 && <span style={{ color: '#ea580c' }}>🟠{workspace.counts.blocked}阻塞</span>}
          {workspace.counts.success > 0 && <span style={{ color: '#16a34a' }}>🟢{workspace.counts.success}完成</span>}
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
