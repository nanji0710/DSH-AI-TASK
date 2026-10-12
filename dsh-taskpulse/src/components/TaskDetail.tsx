/**
 * TaskDetailView —— 单个任务的完整视图（规范 11 组件列表中的 TaskDetail）。
 *
 * 与 TaskCard 的区别：TaskCard 是列表里的摘要（列表视图用），
 * TaskDetailView 是点开后的完整面板（详情视图用），展示全部 Timeline 与元信息。
 */

import type { ReactElement } from 'react'
import { formatRelativeTime, runDuration, statusLabel, type TaskDetail } from '../models'
import { StatusBadge, StatusDot } from './StatusBadge'
import { Timeline } from './Timeline'
import { ConfirmCard } from './ConfirmCard'

export interface TaskDetailViewProps {
  task: TaskDetail
  now: number
  onBack?: () => void
  /** 跳回会话处理确认（只读插件不代做决策）。 */
  onOpen?: (sessionId: string) => void
}

export function TaskDetailView({ task, now, onBack, onOpen }: TaskDetailViewProps): ReactElement {
  return (
    <div className="tp-group" style={{ margin: 12 }}>
      <div className="tp-card-row" style={{ marginBottom: 10 }}>
        <span className="tp-card-title">
          <StatusDot status={task.status} />
          <span className="tp-card-title-text" title={task.title}>
            {task.title}
          </span>
        </span>
        <StatusBadge status={task.status} />
      </div>

      <div className="tp-card-meta">
        {task.agent !== null && (
          <div className="tp-card-meta-line">
            <span className="tp-card-meta-key">Agent: </span>
            {task.agent}
          </div>
        )}
        {task.model !== null && (
          <div className="tp-card-meta-line">
            <span className="tp-card-meta-key">模型: </span>
            {task.model}
          </div>
        )}
        {task.currentStep !== null && (
          <div className="tp-card-meta-line" title={task.currentDetail ?? undefined}>
            <span className="tp-card-meta-key">当前执行：</span>
            {task.currentStep}
          </div>
        )}
        {/*
          耗时只在**真的测到了本轮起点**时并入状态行。
          早先这里无条件渲染 `· 耗时: {runDuration(...)}`，而 `runDuration`
          对未知起点返回 `—` ⇒ 详情页同样会出现一行「耗时: —」。
          未知就如实不写，而不是写一个占位符假装有数据。
        */}
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">状态: </span>
          {statusLabel(task.status)}
          {task.runStartedAt !== null && (
            <>
              <span className="tp-card-meta-key"> · 耗时: </span>
              {runDuration(task, now)}
            </>
          )}
        </div>
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">轮次: </span>
          第 {task.turn} 轮
          <span className="tp-card-meta-key"> · 步骤: </span>
          {task.steps}
          <span className="tp-card-meta-key"> · 工具: </span>
          {task.toolCalls}
        </div>
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">对话创建: </span>
          {new Date(task.startedAt).toLocaleString()}
          <span className="tp-card-meta-key"> · 最近动作: </span>
          {formatRelativeTime(task.lastActionTime, now)}
        </div>
        {task.runStartedAt !== null && (
          <div className="tp-card-meta-line">
            <span className="tp-card-meta-key">本轮开始: </span>
            {new Date(task.runStartedAt).toLocaleString()}
          </div>
        )}
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">会话: </span>
          {task.sessionId}
        </div>
      </div>

      {task.status === 'RUNNING' && (
        <div className="tp-progress">
          <div className="tp-progress-bar" style={{ width: `${Math.round(task.progress * 100)}%` }} />
        </div>
      )}

      {task.error !== null && <div className="tp-error">{task.error}</div>}

      {task.pendingConfirm !== null && <ConfirmCard confirm={task.pendingConfirm} onOpen={onOpen} sessionId={task.sessionId} />}

      <div style={{ marginTop: 12 }}>
        <div className="tp-card-meta-key" style={{ fontSize: 12, marginBottom: 4 }}>
          执行时间线（{task.timeline.length} 条）
        </div>
        <Timeline entries={task.timeline} limit={40} />
      </div>

      {onBack !== undefined && (
        <div className="tp-confirm-actions" style={{ marginTop: 12 }}>
          <button type="button" className="tp-action" onClick={onBack}>
            ← 返回列表
          </button>
        </div>
      )}
    </div>
  )
}

export default TaskDetailView
