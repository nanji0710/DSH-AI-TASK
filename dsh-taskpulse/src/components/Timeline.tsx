/**
 * Timeline —— 任务时间线（规范 8：✓ 完成 / ● 进行中 / ○ 未开始）。
 *
 * 数据来自宿主半边归约出的 `TaskDetail.timeline`（浏览器半边无法直接读
 * session/event，见 host 调研结论），因此这里只负责渲染。
 */

import type { ReactElement } from 'react'
import type { TimelineEntry, TimelineState } from '../models'

/** 状态符号（规范 8 图例）。 */
const MARKS: Record<TimelineState, string> = {
  done: '✓',
  active: '●',
  todo: '○',
  failed: '✕'
}

export interface TimelineProps {
  entries: TimelineEntry[]
  /** 最多展示条数（超出时保留最新的）。 */
  limit?: number
  /** 是否显示每行耗时。 */
  showTime?: boolean
}

export function Timeline({ entries, limit = 8, showTime = true }: TimelineProps): ReactElement | null {
  if (entries.length === 0) return null
  const visible = entries.length > limit ? entries.slice(entries.length - limit) : entries
  return (
    <div className="tp-timeline">
      {visible.map((entry, index) => (
        <div key={`${entry.seq ?? entry.time}-${index}`}>
          <div className="tp-timeline-row">
            <span className="tp-timeline-mark" data-state={entry.status}>
              {MARKS[entry.status] ?? '○'}
            </span>
            <span className="tp-timeline-action" title={entry.action}>
              {entry.action}
            </span>
            {showTime && <span className="tp-timeline-time">{clockTime(entry.time)}</span>}
          </div>
          {entry.detail !== undefined && entry.detail.length > 0 && (
            <div className="tp-timeline-detail" title={entry.detail}>
              {entry.detail}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** HH:MM:SS（时间线用绝对时刻，比相对时间更易定位）。 */
function clockTime(time: number): string {
  const date = new Date(time)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export default Timeline
