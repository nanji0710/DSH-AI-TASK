/**
 * 浏览器半边与宿主半边的通信（规范 5 事件流的跨半边段）。
 *
 * 端点由宿主半边的 BridgeService 通过 `connection.fetch.register` 注册，
 * 挂在页面同源 `/api/dsh-taskpulse/*` 上，因此这里无需任何注入，
 * 直接 `fetch(相对路径)` 即可（cookie 认证由 DSH 自己处理）。
 */

import type { DetailResponse, HistoryItem, StatusCounts, TaskDetail, PendingConfirm } from '../models'

/** 与宿主半边保持一致的端点前缀。 */
const API_PREFIX = '/api/dsh-taskpulse'

/** 宿主快照响应。 */
export interface HostSnapshot {
  ok: boolean
  error?: string
  stats: StatusCounts
  workspaces: Array<{
    id: string
    name: string
    path: string
    conversationCount: number
    counts: StatusCounts
    updatedAt: number
  }>
  details: Record<string, TaskDetail>
  conversations: TaskDetail[]
  pending: Array<PendingConfirm & { sessionId: string; title: string }>
}

/** 空统计（桥不可用时的占位）。 */
export function emptyStats(): StatusCounts {
  return { running: 0, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 0 }
}

/** 是否已禁用（避免桥故障时每 2 秒刷屏 console）。 */
let disabled = false
let warned = false

/**
 * 拉取一次宿主快照。
 *
 * @param signal - 用于取消（组件卸载时中止请求）。
 * @returns 快照；桥不可用时返回 `null`（调用方回退到本地数据源）。
 */
export async function fetchSnapshot(signal?: AbortSignal): Promise<HostSnapshot | null> {
  if (disabled) return null
  try {
    const response = await fetch(`${API_PREFIX}/snapshot`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as HostSnapshot
    if (body?.ok !== true) throw new Error(body?.error ?? '宿主半边返回失败')
    deviceReady()
    return body
  } catch (error) {
    // 宿主半边未启用（例如插件只装了浏览器半边）时不视为错误，静默退化。
    if (!warned) {
      warned = true
      // eslint-disable-next-line no-console
      console.warn(
        '[taskpulse] 宿主半边不可达，任务详情退化为本地状态源：',
        error instanceof Error ? error.message : String(error)
      )
    }
    return null
  }
}

/** 拉取历史记录。 */
export async function fetchHistory(signal?: AbortSignal): Promise<HistoryItem[] | null> {
  if (disabled) return null
  try {
    const response = await fetch(`${API_PREFIX}/history`, {
      method: 'GET',
      headers: { accept: 'application/json' },
      signal
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = (await response.json()) as { ok: boolean; items?: HistoryItem[]; error?: string }
    if (body?.ok !== true) throw new Error(body?.error ?? '宿主半边返回失败')
    return body.items ?? []
  } catch {
    return null
  }
}

function deviceReady(): void {
  warned = false
}

export type { DetailResponse }
