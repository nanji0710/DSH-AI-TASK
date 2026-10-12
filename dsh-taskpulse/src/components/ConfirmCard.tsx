/**
 * ConfirmCard —— 确认中心卡片（规范 9：AI 建议 + 修改内容 + 确认按钮）。
 *
 * DSH 有两条互相独立的「等人」通道（见 `PendingConfirm.kind`）：
 * - `approval`：工具要动文件/执行命令，问「能不能做」——读作「待确认」；
 * - `question`：`ask_user_question` / `exit_plan_mode` 问用户「想怎么做」——读作「等待答复」。
 * 两者都是「整轮停住等用户」，因此共用一张卡片，只换标题与字段名。
 *
 * ⚠️ 权限边界（规范 8）：本插件**只读**，绝不代用户做确认决定。
 * 因此这里的按钮不是「批准 / 拒绝」的写入开关 —— 它们只把用户**带回**
 * 触发确认的那个会话，由用户在原生的 DSH 确认 UI 里完成决策。
 * 这样既满足「确认中心」的信息展示职责，又不越过规范划定的权限红线。
 */

import type { ReactElement } from 'react'
import type { PendingConfirm } from '../models'

export interface ConfirmCardProps {
  confirm: PendingConfirm
  /** 跳回会话（由上层提供；缺省时按钮不渲染）。 */
  onOpen?: (sessionId: string) => void
  sessionId?: string
}

export function ConfirmCard({ confirm, onOpen, sessionId }: ConfirmCardProps): ReactElement {
  const actionable = onOpen !== undefined && sessionId !== undefined
  const isQuestion = confirm.kind === 'question'
  const title = `${isQuestion ? '等待答复' : '待确认'}：${confirm.toolName}`
  const actionLabel = isQuestion ? '前往会话作答' : '前往会话处理'
  return (
    <div className="tp-confirm">
      <div className="tp-confirm-title">
        <span aria-hidden="true">🟡</span>
        <span>{title}</span>
      </div>
      {confirm.reason !== undefined && confirm.reason.length > 0 && (
        <div className="tp-confirm-body">
          <strong>{isQuestion ? '提问内容：' : 'AI 建议：'}</strong>
          {confirm.reason}
        </div>
      )}
      {confirm.preview !== undefined && confirm.preview.length > 0 && (
        <div className="tp-confirm-body">
          <strong>{isQuestion ? '可选项：' : '修改内容：'}</strong>
          {confirm.preview}
        </div>
      )}
      {actionable ? (
        <div className="tp-confirm-actions">
          <button
            type="button"
            className="tp-action"
            data-primary="true"
            onClick={(event) => {
              event.stopPropagation()
              onOpen(sessionId)
            }}
          >
            {actionLabel}
          </button>
        </div>
      ) : (
        <div className="tp-confirm-actions">
          <span className="tp-confirm-hint">
            {isQuestion ? '请在对应会话中作答（本插件只读）' : '请在对应会话中完成确认（本插件只读）'}
          </span>
        </div>
      )}
    </div>
  )
}

export default ConfirmCard
