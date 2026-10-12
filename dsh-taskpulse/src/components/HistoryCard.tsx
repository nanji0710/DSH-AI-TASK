/**
 * HistoryCard —— 历史记录卡片（规范 6 / 11）。
 *
 * 已从活跃列表归入历史的任务（超过一天无操作）在历史视图里展示，
 * 让用户仍能回溯「刚刚发生了什么」。
 */

import type { ReactElement } from 'react'
import { STATUS_TONE, formatDuration, formatRelativeTime, type HistoryItem } from '../models'
import { StatusBadge } from './StatusBadge'

export interface HistoryCardProps {
  item: HistoryItem
  now: number
}

export function HistoryCard({ item, now }: HistoryCardProps): ReactElement {
  return (
    <div className="tp-history" data-dim={item.status === 'SUCCESS' || undefined}>
      <div className="tp-card-row">
        <span className="tp-card-title">
          <span className="tp-dot" data-tone={STATUS_TONE[item.status] ?? 'gray'} aria-hidden="true" />
          <span className="tp-card-title-text" title={item.title}>
            {item.title}
          </span>
        </span>
        <StatusBadge status={item.status} />
      </div>
      <div className="tp-card-meta">
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">{item.workspaceName} · </span>
          耗时 {item.duration === null ? '—' : formatDuration(item.duration)}
          {item.toolCalls > 0 && <span className="tp-card-meta-key"> · {item.toolCalls} 次工具调用</span>}
        </div>
        <div className="tp-card-meta-line">
          <span className="tp-card-meta-key">结束于 </span>
          {formatRelativeTime(item.finishedAt, now)}
          <span className="tp-card-meta-key"> · {item.summary}</span>
        </div>
        {item.error !== null && <div className="tp-error">{item.error}</div>}
      </div>
    </div>
  )
}

export default HistoryCard
