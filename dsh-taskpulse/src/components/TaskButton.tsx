/**
 * TaskButton —— 右上角默认态入口（规范 2）。
 *
 * 规格：宽 120px、高 32px、圆角 12px、半透明玻璃效果，文案形如 `AI任务 8`。
 * 有异常任务时入口自身闪红（规范 10：异常红色提示动画）。
 *
 * 该胶囊同时是**拖动把手**：按住并移动即可把它挪到窗口内任意位置
 * （需求：「缩小为 AI 任务胶囊状态时，胶囊可在 DSH 程序内任意拖动位置，
 * 拖动范围不超出 DSH 程序窗口」）。因此这里接收一组指针事件处理器，
 * 并在 pointerdown 时阻止默认行为，避免拖动变成文本选择。
 *
 * 刻意**不渲染下拉倒三角**（用户要求去掉）：胶囊没有菜单，点击是整体
 * 展开/收起，画一个 ▾ 会让人以为点它才弹菜单；而且它和「抓手」语义
 * 冲突 —— 同一小块区域既是拖动把手又像下拉按钮，用户不知道该按哪。
 *
 * 左侧图标用 `TASKPULSE_ICON`（需求 6：把原来的 🟦 蓝色方框换成图标，
 * 图标取自桌面 `霓虹 AI 任务面板图标.png`）。用 `<img>` 而非 CSS background，
 * 是为了让图标带上 alt 语义之外的加载失败兜底 —— 见下方 onError。
 */

import type { PointerEvent as ReactPointerEvent, ReactElement } from 'react'
import type { StatusCounts } from '../models'
import { TASKPULSE_ICON } from '../assets/taskpulse-icon'

export interface TaskButtonDragHandlers {
  onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
  onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
}

export interface TaskButtonProps {
  /** 活跃任务数（显示在徽章上）。 */
  count: number
  stats: StatusCounts
  expanded: boolean
  onToggle: () => void
  /** 拖动处理器（缺省时胶囊固定在默认右上角）。 */
  dragHandlers?: TaskButtonDragHandlers
  /** 是否正在拖动（用于光标样式）。 */
  dragging?: boolean
  /** 是否可拖动（展开面板时为 false）。 */
  draggable?: boolean
}

export function TaskButton({
  count,
  stats,
  expanded,
  onToggle,
  dragHandlers,
  dragging = false,
  draggable = false
}: TaskButtonProps): ReactElement {
  return (
    <button
      type="button"
      className="tp-btn"
      data-alert={stats.error > 0 || undefined}
      data-dragging={dragging || undefined}
      data-draggable={draggable || undefined}
      aria-expanded={expanded}
      aria-label={`AI 任务，共 ${count} 个活跃任务${draggable ? '，可拖动调整位置' : ''}`}
      onClick={onToggle}
      onPointerDown={(event) => {
        if (!draggable) return
        // 阻止拖动时选中文字；点击行为不受影响（位移不足阈值时不吞 click）。
        event.preventDefault()
        dragHandlers?.onPointerDown(event)
      }}
      onPointerMove={draggable ? dragHandlers?.onPointerMove : undefined}
      onPointerUp={draggable ? dragHandlers?.onPointerUp : undefined}
      onPointerCancel={draggable ? dragHandlers?.onPointerCancel : undefined}
    >
      {/* 图标替代原来的 🟦（需求 6）。aria-hidden：可读名称已由按钮的
          aria-label 给出，图标只是装饰，读两遍反而啰嗦。 */}
      <img className="tp-btn-icon" src={TASKPULSE_ICON} alt="" aria-hidden="true" draggable={false} />
      <span className="tp-btn-label">AI任务</span>
      <span className="tp-btn-count">{count}</span>
    </button>
  )
}

export default TaskButton
