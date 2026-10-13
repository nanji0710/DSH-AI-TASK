/**
 * ConversationItem —— 会话条目（规范 5）。
 *
 * 展示：对话名称、当前任务、最近动作时间。
 * 形如：`💬 API开发` · `执行中` · `3分钟前`
 */

import type { ReactElement } from 'react'
import { STATUS_LABEL, formatRelativeTime, type TaskDetail } from '../models'
import { StatusDot } from './StatusBadge'

export interface ConversationItemProps {
  task: TaskDetail
  now: number
  onSelect?: (sessionId: string) => void
  /** 缩进层级（嵌套在工作区分组内时用）。 */
  indent?: boolean
}

export function ConversationItem({ task, now, onSelect, indent = true }: ConversationItemProps): ReactElement {
  const clickable = onSelect !== undefined
  return (
    <div
      className="tp-conv"
      style={indent ? { paddingLeft: 10 } : undefined}
      role={clickable ? 'button' : undefined}
      tabIndex={clickable ? 0 : undefined}
      onClick={clickable ? () => onSelect(task.sessionId) : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onSelect(task.sessionId)
              }
            }
          : undefined
      }
      title={task.currentStep ?? task.title}
    >
      <StatusDot status={task.status} />
      <span className="tp-conv-name">💬 {task.title}</span>
      <span className="tp-conv-time">
        {STATUS_LABEL[task.status]} · {formatRelativeTime(task.lastActionTime, now)}
      </span>
    </div>
  )
}

export default ConversationItem
