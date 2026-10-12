/**
 * 轮询 hook：按固定间隔拉取宿主半边快照。
 *
 * 为什么用轮询而不是 SSE：本插件的实时性需求是「秒级展示任务状态」，
 * 轮询实现更简单、无长连接泄漏风险，且与本插件「不干扰主对话」的原则一致
 * （每次请求都是 KB 级 JSON）。
 *
 * 页面不可见时自动降频（30s），避免后台标签页持续打扰宿主。
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { HistoryItem } from '../models'
import { loadHostData } from '../store/client-store'
import type { HostSnapshot } from '../services/client-api'

/** 前台轮询间隔。 */
const ACTIVE_INTERVAL_MS = 2000
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
 * @param enabled - 面板关闭时可传 false 暂停轮询，进一步降低开销。
 */
export function useHostData(enabled: boolean): HostData {
  const [snapshot, setSnapshot] = useState<HostSnapshot | null>(null)
  const [history, setHistory] = useState<HistoryItem[]>([])
  const mounted = useRef(true)
  const inFlight = useRef(false)
  const controller = useRef<AbortController | null>(null)

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
    if (!enabled) return () => {
      mounted.current = false
    }

    let timer: ReturnType<typeof setTimeout> | null = null

    const schedule = () => {
      const interval = document.visibilityState === 'visible' ? ACTIVE_INTERVAL_MS : IDLE_INTERVAL_MS
      timer = setTimeout(() => {
        void pull().finally(() => {
          if (mounted.current) schedule()
        })
      }, interval)
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
  }, [enabled, pull])

  return { snapshot, history, refresh: () => void pull() }
}
