/**
 * 轮询 hook：按固定间隔拉取宿主半边快照。
 *
 * 为什么用轮询而不是 SSE：本插件的实时性需求是「秒级展示任务状态」，
 * 轮询实现更简单、无长连接泄漏风险，且与本插件「不干扰主对话」的原则一致
 * （每次请求都是 KB 级 JSON）。
 *
 * 三档间隔：
 *   - 面板展开 2s  —— 用户正盯着列表，要跟得上；
 *   - 胶囊态 5s    —— 状态变迁提示（需求 m04869）要在收起时也能发现变迁。
 *                     5s 与提示自身的存活时长（5s）同量级：最坏情况下
 *                     变迁晚 5 秒被看到，随后完整显示 5 秒；
 *   - 页面不可见 30s —— 后台标签页没必要保持前台频率。
 *
 * ⚠️ 早先这里在收起时**完全暂停轮询**。需求 m04869 之后不能这么做了：
 * ERROR / BLOCKED 这类结论只存在于宿主半边的事件流里（浏览器半边只有
 * running / pendingInteraction），暂停就等于「收起时再也收不到异常提示」。
 * 收起态改用更长的间隔来平衡开销，而不是直接停掉。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryItem } from '../models'
import { loadHostData } from '../store/client-store'
import type { HostSnapshot } from '../services/client-api'

/** 面板展开时的轮询间隔。 */
const ACTIVE_INTERVAL_MS = 2000
/** 胶囊态（面板收起）的轮询间隔。 */
const COLLAPSED_INTERVAL_MS = 5000
/** 后台（页面不可见）轮询间隔。 */
const IDLE_INTERVAL_MS = 30000

export interface HostData {
  snapshot: HostSnapshot | null
  history: HistoryItem[]
  /** 手动刷新。 */
  refresh: () => void
}

/**
 * 订阅宿主半边数据。
 *
 * @param expanded - 面板是否展开；只影响轮询频率，不再决定是否轮询。
 */
export function useHostData(expanded: boolean): HostData {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)

  // 用 ref 读 expanded：间隔变化不该重启整个轮询循环（会丢掉正在排队的
  // 那一拍，并让每次展开/收起都多发一次请求）。
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded

  const pull = useCallback(async () => {
    if (inFlight.current) return
    inFlight.current = true
    controller.current?.abort()
    const next = new AbortController()
    controller.current = next
    try {
      const data = await loadHostData(next.signal)
      if (!mounted.current) return
      setSnapshot(data.snapshot)
      setHistory(data.history)
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    mounted.current = true

    let timer: ReturnType<typeof setTimeout> | null = null

    const interval = (): number => {
      if (document.visibilityState !== 'visible') return IDLE_INTERVAL_MS
      return expandedRef.current ? ACTIVE_INTERVAL_MS : COLLAPSED_INTERVAL_MS
    }

    const schedule = () => {
      timer = setTimeout(() => {
        void pull().finally(() => {
          if (mounted.current) schedule()
        })
      }, interval())
    }

    void pull().finally(() => {
      if (mounted.current) schedule()
    })

    const onVisible = () => {
      if (document.visibilityState === 'visible') void pull()
    }
    document.addEventListener('visibilitychange', onVisible)

    return () => {
      mounted.current = false
      if (timer !== null) clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisible)
      controller.current?.abort()
    }
  }, [pull])

  return { snapshot, history, refresh: () => void pull() }
}
