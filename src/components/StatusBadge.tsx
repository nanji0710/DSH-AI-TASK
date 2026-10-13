/**
 * StatusBadge —— 任务状态徽章（规范 7 色表 + 规范 11 组件列表）。
 *
 * 状态映射：RUNNING 蓝 / WAIT_CONFIRM 黄 / SUCCESS 绿 / ERROR 红 / BLOCKED 橙 / START 灰。
 */

import type { ReactElement } from 'react'
import { STATUS_LABEL, STATUS_TONE, type TaskStatus } from '../models'

export interface StatusBadgeProps {
  status: TaskStatus
  /** 紧凑模式（工作区分组里的计数用）。 */
  compact?: boolean
}

export function StatusBadge({ status, compact = false }: StatusBadgeProps): ReactElement {
  const tone = STATUS_TONE[status] ?? 'gray'
  return (
    <span className="tp-badge" data-tone={tone} data-compact={compact || undefined} title={STATUS_LABEL[status]}>
      {STATUS_LABEL[status] ?? status}
    </span>
  )
}

/** 状态圆点（执行中带蓝色呼吸动画，规范 10）。 */
export function StatusDot({ status }: { status: TaskStatus }): ReactElement {
  return <span className="tp-dot" data-tone={STATUS_TONE[status] ?? 'gray'} aria-hidden="true" />
}

export default StatusBadge
