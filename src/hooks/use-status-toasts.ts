/**
 * use-status-toasts —— 把「状态变迁」变成「一串会自动消失的提示」。
 *
 * 需求（m04869）：任务新进入一个状态时，**在胶囊态**弹出提示，5 秒后自动消失。
 *
 * 三件事都在这里完成，判定规则本身在 models/status-transition.ts（纯函数，可断言）：
 *
 *   1. 变迁侦测：拿一份长期存活的「状态账本」（useRef 里的 Map），
 *      每次 tasks 变化就 diff 一次，只把真正变了且值得提示的条目取出来。
 *      账本写在 ref 里而不是 state 里 —— 它是比对用的记忆，不是渲染数据，
 *      放 state 会触发多余的渲染，也会在 React 严格模式下被打乱。
 *
 *   2. 胶囊态判定（enabled）：需求明确说「如果当前处于胶囊状态」。
 *      面板展开时**不弹**提示 —— 用户正盯着 360x600 的列表，
 *      状态变化就在眼前，再弹一条浮窗纯属遮挡。而提示本身是给
 *      「收起时不看列表」的场景用的，这是它唯一存在的理由。
 *      ⇒ 展开时不仅不新增，还要把已显示的清空（见下方 effect 的注释）。
 *
 *   3. 到期清理：按时间戳判断（不是计数），每 250ms 扫一次。
 *      250ms 而不是 1000ms：如果按整秒扫，5 秒的提示最长会存活近 6 秒；
 *      250ms 让「5 秒后消失」的误差缩到人眼看不出的范围。
 *
 * 面板展开期间账本照常更新（这一点很重要）：用户收起面板时，
 * 不应该把展开期间积累的一堆变迁一起补报出来 —— 那些状态他已经看到了。
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import type { TaskDetail } from '../models'
import {
  TOAST_TTL_MS,
  admitTransitions,
  diffStatuses,
  mergeToasts,
  pruneToasts,
  type StatusLedger,
  type StatusToast
} from '../models'

/** 到期扫描间隔（见文件头第 3 条）。 */
const SWEEP_INTERVAL_MS = 250

export interface StatusToastsResult {
  /** 当前应显示的提示（按发生时间升序）。 */
  toasts: StatusToast[]
  /** 清空全部（面板展开时调用）。 */
  dismiss: () => void
  /** 关掉指定的一条（提示上的 ✕）。 */
  dismissOne: (id: string) => void
}

/**
 * 侦测状态变迁并维护提示队列。
 *
 * @param tasks - 合并后的任务列表（`buildViewModel().tasks`）。
 * @param enabled - 是否处于胶囊态（false = 面板展开，不弹提示）。
 */
export function useStatusToasts(tasks: readonly TaskDetail[], enabled: boolean): StatusToastsResult {
  const [toasts, setToasts] = useState<StatusToast[]>([])
  const ledger = useRef<StatusLedger>(new Map())

  // 用 ref 读 enabled：diff 只该由 tasks 变化驱动。若把 enabled 写进依赖，
  // 关闭面板（enabled 变 true）会立刻触发一次 diff —— 那正好是「补报一批
  // 展开期间的变化」，与文件头的结论相反。
  const enabledRef = useRef(enabled)
  enabledRef.current = enabled

  useEffect(() => {
    const transitions = diffStatuses(ledger.current, tasks)
    // 账本无论如何都更新了（上面这行），所以「不提示」不会让状态漏记。
    // 胶囊态门控走公开的 admitTransitions：丢弃，不是延后（见其 docstring）。
    const admitted = admitTransitions(transitions, enabledRef.current)
    if (admitted.length === 0) return
    setToasts((current) => mergeToasts(current, admitted))
  }, [tasks])

  // 面板展开：清掉已显示的提示。用户已经能看到完整列表了，
  // 让一条浮窗继续悬在那里只会挡住面板右上角。
  useEffect(() => {
    if (!enabled) setToasts([])
  }, [enabled])

  useEffect(() => {
    if (toasts.length === 0) return undefined
    const timer = setInterval(() => {
      setToasts((current) => pruneToasts(current, Date.now()))
    }, SWEEP_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [toasts.length])

  const dismiss = useMemo(() => () => setToasts([]), [])
  const dismissOne = useMemo(() => (id: string) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  return { toasts, dismiss, dismissOne }
}
