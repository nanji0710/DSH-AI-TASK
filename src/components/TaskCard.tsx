/**
 * TaskCard —— 任务卡片（规范 6）。
 *
 * 列表**只回答两个问题**：这条对话现在处于什么状态、正在做哪一步。
 * 因此这里只渲染：
 *   状态点 + 标题 + 状态徽章 / `Agent: xxx` / `当前执行：xxx`
 *
 * 刻意**不渲染** Timeline、工具调用次数与子代理条目 —— 那些是执行流水，
 * 属于详情视图（TaskDetail）的职责；混进列表会把「一眼看清状态」淹没在噪音里。
 * 异常卡片保留一行错误原因：它是「异常」状态的内容本身，不是流水。
 *
 * 也刻意**不渲染运行/耗时**（用户要求删掉）。原因不是它没用，而是它在
 * 真实数据下几乎永远没有值：`runStartedAt` 只在插件亲眼看到 `turn/start`
 * 或 `user/message` 时才写入，而列表里绝大多数是插件启用前就已存在的
 * 历史会话 —— 于是整列卡片挂着一排「运行: —」。一行恒为「—」的字
 * 不传递信息，只让人怀疑功能坏了。耗时仍然保留在详情视图（TaskDetail）
 * 的「本轮开始」一行里，那里有完整上下文，且同样带 null 守卫。
 */

import type { ReactElement } from 'react'
import { taskStepText, type TaskDetail } from '../models'
import { StatusBadge, StatusDot } from './StatusBadge'

export interface TaskCardProps {
  task: TaskDetail
  /** 点击卡片（展开 TaskDetail 视图）。 */
  onSelect?: (sessionId: string) => void
}

export function TaskCard({ task, onSelect }: TaskCardProps): ReactElement {
  const clickable = onSelect !== undefined
  const step = taskStepText(task)
  return (
    <div
      className="tp-card"
      data-clickable={clickable || undefined}
      data-status={task.status}
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
    >
      <div className="tp-card-row">
        <span className="tp-card-title">
          <StatusDot status={task.status} />
          <span className="tp-card-title-text" title={task.title}>
            {task.title}
          </span>
        </span>
        <StatusBadge status={task.status} />
      </div>

      <div className="tp-card-meta">
        {task.agent !== null && <div className="tp-card-meta-line">Agent: {task.agent}</div>}
        {step !== null && (
          <div className="tp-card-meta-line" title={task.currentDetail ?? undefined}>
            <span className="tp-card-meta-key">当前执行：</span>
            {step}
          </div>
        )}
      </div>

      {task.error !== null && <div className="tp-error">{task.error}</div>}
    </div>
  )
}

export default TaskCard
