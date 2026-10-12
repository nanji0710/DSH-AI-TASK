/**
 * StatusToast —— 状态变迁提示弹窗（需求 m04869）。
 *
 * 弹出的时机与理由见 models/status-transition.ts，这里只负责画出来：
 *
 *   [状态圆点]  会话标题                          [✕]
 *               由「进行中」变为「待确认」
 *
 * 设计取舍：
 *   - 点整条 = 展开面板并定位到这条对话（「看到提示 → 点开看详情」是它唯一的用法）；
 *   - 右上角 ✕ 手动关掉：5 秒后自动消失是需求，但一条挡在窗口上的浮窗
 *     如果在这 5 秒里正好挡住用户要看的东西，必须能立刻赶走它；
 *   - 颜色沿用状态色表（规范 7），与面板里的 StatusBadge 完全一致 ——
 *     同一个状态在胶囊、卡片、提示里必须是同一个颜色，否则颜色就失去意义了。
 */

import type { ReactElement } from 'react'
import { STATUS_LABEL, STATUS_TONE, transitionText, type StatusToast } from '../models'

export interface StatusToastCardProps {
  toast: StatusToast
  /** 点开后跳到的会话（由上层展开面板并选中）。 */
  onOpen?: (sessionId: string) => void
  /** 手动关掉这一条。 */
  onDismiss?: (id: string) => void
}

export function StatusToastCard({ toast, onOpen, onDismiss }: StatusToastCardProps): ReactElement {
  const tone = STATUS_TONE[toast.to] ?? 'gray'
  const clickable = onOpen !== undefined

  const onActivate = (): void => {
    if (onOpen !== undefined) onOpen(toast.sessionId)
  }

  return (
    <div
      className="tp-toast"
      data-tone={tone}
      role={clickable ? 'button' : 'status'}
      tabIndex={clickable ? 0 : undefined}
      title={`${toast.title} —— ${transitionText(toast.from, toast.to)}`}
      onClick={clickable ? onActivate : undefined}
      onKeyDown={
        clickable
          ? (event) => {
              if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault()
                onActivate()
              }
            }
          : undefined
      }
    >
      <span className="tp-toast-dot" aria-hidden="true" />
      <div className="tp-toast-main">
        <div className="tp-toast-title">{toast.title}</div>
        <div className="tp-toast-sub">{transitionText(toast.from, toast.to)}</div>
      </div>
      <button
        type="button"
        className="tp-toast-close"
        aria-label={`关闭「${STATUS_LABEL[toast.to] ?? toast.to}」提示`}
        onClick={(event) => {
          event.stopPropagation()
          onDismiss?.(toast.id)
        }}
      >
        ✕
      </button>
    </div>
  )
}

export default StatusToastCard
