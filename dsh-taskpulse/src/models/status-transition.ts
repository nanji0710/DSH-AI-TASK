/**
 * status-transition —— 状态变迁模型（纯逻辑，零依赖）。
 *
 * 需求（m04869）：「当某个任务新进入一个状态时（例如从运行变为确认、从运行变为完成），
 * 如果当前处于胶囊状态，就在胶囊的上方或下方弹出一个提示弹窗，5 秒后自动消失。」
 *
 * 这个文件负责需求里的**判定部分**，不碰 DOM 也不碰 React：
 *
 *   1. 触发时机 = 「状态真的变了」那一刻。
 *      判定靠一份**状态账本**（`StatusLedger`：sessionId → 上次看到的状态）：
 *      每次拿到新的任务列表，逐条比对，只把 `before !== after` 的条目算作变迁。
 *      ⇒ 这不是「有新任务就提示」，也不是「列表渲染一次就提示」。
 *
 *   2. 首次观测**不提示**（`before === undefined` 只记账）。
 *      插件刚加载、面板刚打开、某个会话第一次出现在列表里 —— 这些都只是
 *      「我们现在才看到它」，不是「它刚刚变了」。用户要的是变迁提示，
 *      不是把已有状态重播一遍；否则每次刷新都会炸出一屏弹窗。
 *
 *   3. 只有「值得打断用户」的目标状态才提示（`isToastworthy`）。
 *      - WAIT_CONFIRM：正在等你确认，不提示就会一直卡着（最高价值）；
 *      - SUCCESS / ERROR / BLOCKED：任务收尾，用户需要知道结果；
 *      - RUNNING / START：**不提示**。每轮对话开始、每次工具调用后
 *        状态都会回到 RUNNING，提示它等于给每一次动作弹一次窗，
 *        弹窗会立刻变成噪音，反而盖掉上面三条真正重要的信息。
 *
 *   4. 消失不提示。任务被归档（24 小时无动作）或会话被删除时只是从列表里
 *      消失，账本随之清掉；「它不见了」不是一次状态变迁。
 *
 * 判定逻辑与 UI 分离，是为了让这些边界可以直接断言（见 test/toast.test.mjs）——
 * 「什么时候不该弹」比「什么时候该弹」更容易出错，也更难在 GUI 里试出来。
 */

import { STATUS_LABEL, TASK_STATUS, type TaskDetail, type TaskStatus } from './types'

/** 提示弹窗存活时长（需求：5 秒后自动消失）。 */
export const TOAST_TTL_MS = 5000

/** 同时最多显示的提示条数（堆太多会盖住右上角，反而看不见任务）。 */
export const TOAST_LIMIT = 3

/**
 * 值得弹出提示的目标状态。
 *
 * 刻意不含 RUNNING / START：见文件头第 3 条。
 */
export const TOAST_STATUSES: TaskStatus[] = [
  TASK_STATUS.WAIT_CONFIRM,
  TASK_STATUS.SUCCESS,
  TASK_STATUS.ERROR,
  TASK_STATUS.BLOCKED
]

/** 该状态是否值得打断用户。 */
export function isToastworthy(status: TaskStatus): boolean {
  return TOAST_STATUSES.indexOf(status) >= 0
}

/**
 * 状态账本：会话 id → 上一次观测到的状态。
 *
 * 由 `diffStatuses` 就地更新，调用方持有一份长期存活的 Map（React 里用 useRef）。
 */
export type StatusLedger = Map<string, TaskStatus>

/** 一次状态变迁（账本比对的结果）。 */
export interface StatusTransition {
  sessionId: string
  /** 会话标题（弹窗里要写清是哪条对话）。 */
  title: string
  from: TaskStatus
  to: TaskStatus
  /** 观测时刻（本插件观测到的时间，不是宿主事件的 time）。 */
  at: number
}

/** 一条待显示的提示（UI 直接渲染它）。 */
export interface StatusToast {
  /** 稳定 id：用作 React key 与定时器键。 */
  id: string
  sessionId: string
  title: string
  from: TaskStatus
  to: TaskStatus
  at: number
}

/**
 * 比对状态账本，返回本次新发生的变迁，并把账本更新到当前状态。
 *
 * ⚠️ 会就地修改 `ledger`（这正是它能做到「首次观测不提示」的原因）：
 * 账本必须始终等于「我们上一次看到的状态」，否则每次比对都会重复报同一次变迁。
 *
 * @param ledger - 调用方持有的长期账本。
 * @param tasks - 当前任务列表（宿主快照 + 浏览器半边合成后的结果）。
 * @param at - 观测时刻，默认 Date.now()。
 */
export function diffStatuses(
  ledger: StatusLedger,
  tasks: readonly TaskDetail[],
  at: number = Date.now()
): StatusTransition[] {
  const out: StatusTransition[] = []
  const seen = new Set<string>()

  for (const task of tasks) {
    const id = task.sessionId
    if (typeof id !== 'string' || id.length === 0) continue
    seen.add(id)

    const before = ledger.get(id)
    const after = task.status
    // 首次观测：只记账。见文件头第 2 条。
    if (before === undefined) {
      ledger.set(id, after)
      continue
    }
    if (before === after) continue

    ledger.set(id, after)
    // 回到 RUNNING 之类的「不值得打断」的目标状态：记账但不出声。
    if (!isToastworthy(after)) continue

    out.push({ sessionId: id, title: task.title, from: before, to: after, at })
  }

  // 消失的任务从账本里清掉：「它不见了」不是一次状态变迁（文件头第 4 条）。
  // 若它日后重新出现，会被当作首次观测 —— 宁可少提示，也不要补报一次陈旧的变迁。
  for (const id of Array.from(ledger.keys())) {
    if (!seen.has(id)) ledger.delete(id)
  }

  return out
}

/**
 * 把新变迁并入当前提示队列。
 *
 * 去重规则：同一会话**同一个目标状态**已在队列里，就用新的一条替换它
 * （刷新存活时间），而不是并排堆两条「待确认」。这在
 * 「等待确认 → 恢复运行 → 又等待确认」这种来回摆动时不至于刷屏。
 *
 * 上限：只保留最新的 `limit` 条（先进先出）。批量归档或宿主重启时
 * 可能一次涌入十几条变迁，全弹出来会盖满右上角。
 */
export function mergeToasts(
  current: readonly StatusToast[],
  incoming: readonly StatusTransition[],
  limit: number = TOAST_LIMIT
): StatusToast[] {
  if (incoming.length === 0) return current as StatusToast[]

  const next = current.slice()
  for (const transition of incoming) {
    const toast: StatusToast = {
      id: `${transition.sessionId}:${transition.at}`,
      sessionId: transition.sessionId,
      title: transition.title,
      from: transition.from,
      to: transition.to,
      at: transition.at
    }
    const duplicate = next.findIndex(
      (item) => item.sessionId === toast.sessionId && item.to === toast.to
    )
    if (duplicate >= 0) {
      next[duplicate] = toast
      continue
    }
    next.push(toast)
  }
  return next.length > limit ? next.slice(next.length - limit) : next
}

/**
 * 胶囊态门控（需求：**如果当前处于胶囊状态**才弹提示）。
 *
 * 关键语义是**丢弃，而不是排队延后**：面板展开时用户正盯着列表，
 * 状态变化就在眼前；若把这些变迁攒起来等他收起面板再补报，
 * 会一次性炸出一批已经过时的提示。宁可少提示。
 *
 * 抽成一个函数是为了让「丢弃 ≠ 延后」这个区分可以被直接断言 ——
 * 它很容易被后来者「顺手」改成缓存（见 test/toast.test.mjs）。
 */
export function admitTransitions(
  transitions: readonly StatusTransition[],
  capsule: boolean
): readonly StatusTransition[] {
  return capsule ? transitions : []
}

/**
 * 剔除已过期的提示（需求：5 秒后自动消失）。
 *
 * 按 `at + ttl <= now` 判定，**不是**按「入队顺序 + 计数」——
 * 因为同一会话的提示被更新时会续期（见 `mergeToasts`），
 * 序号计数会让它提前消失。用时间戳则天然正确，也便于用假时钟直接断言。
 */
export function pruneToasts(
  toasts: readonly StatusToast[],
  now: number,
  ttl: number = TOAST_TTL_MS
): StatusToast[] {
  const alive = toasts.filter((toast) => now - toast.at < ttl)
  return alive.length === toasts.length ? (toasts as StatusToast[]) : alive
}

/** 弹窗里的一行说明，例如「由『进行中』变为『待确认』」。 */
export function transitionText(from: TaskStatus | undefined, to: TaskStatus): string {
  const target = STATUS_LABEL[to] ?? to
  const source = from === undefined ? undefined : STATUS_LABEL[from] ?? from
  return source === undefined ? `进入「${target}」` : `由「${source}」变为「${target}」`
}
