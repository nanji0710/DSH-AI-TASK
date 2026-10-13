/**
 * use-toast-side —— 量出提示该贴在胶囊的哪一侧（DOM 测量层）。
 *
 * 几何计算本身在 toast-geometry.ts（纯函数）；这里只负责从 DOM 取数：
 *   - 胶囊矩形：`rootRef.current.getBoundingClientRect()`
 *   - 内容区矩形：`readOverlayRect(root)`（与面板定位、胶囊拖动共用同一个实现）
 *
 * 为什么要轮询：提示出现的位置取决于胶囊位置，而拖动胶囊改的是内联样式 ——
 * 尺寸不变、位置变，ResizeObserver 抓不到。与 use-panel-geometry 同样的
 * rAF + 250ms 轮询理由（见那里的注释）。
 *
 * 关于边界来源：`readOverlayRect` 取的是 `.tp-root` 的 `offsetParent`（即 layout 的
 * `div.overlayLayer`，`position: absolute; inset: 0`）矩形 —— 它覆盖整个窗口，
 * 真正的裁切线是 frame 的 `overflow: hidden`，两者边界一致。
 * 所以直接拿它当可用范围即可，无需另算标题栏高度。
 */

import { useEffect, useState, type RefObject } from 'react'
import { readOverlayRect } from './panel-geometry'
import { TOAST_WIDTH, placeToast, type ToastGeometry } from './toast-geometry'

/** 轮询间隔（与 use-panel-geometry 一致）。 */
const POLL_MS = 250

export function useToastSide(rootRef: RefObject<HTMLElement | null>, active: boolean): ToastGeometry {
  const [geometry, setGeometry] = useState<ToastGeometry | null>(null)

  useEffect(() => {
    if (!active) {
      setGeometry(null)
      return undefined
    }
    const root = rootRef.current
    if (root === null || root === undefined) return undefined

    const measure = (): void => {
      const rect = root.getBoundingClientRect()
      // NaN <= 0 为 false，只写 width <= 0 拦不住 NaN（见 use-panel-geometry）。
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height)) return
      if (rect.width <= 0 || rect.height <= 0) return
      const overlay = readOverlayRect(root)
      const next = placeToast({
        capsule: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        overlay
      })
      setGeometry((previous) => {
        if (previous !== null && previous.side === next.side && previous.left === next.left) return previous
        return next
      })
    }

    measure()

    let frame = 0
    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule())
    observer?.observe(root)
    const target = root.offsetParent as HTMLElement | null
    if (target !== null && target !== undefined) observer?.observe(target)
    const poll = window.setInterval(schedule, POLL_MS)

    return () => {
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      observer?.disconnect()
      window.clearInterval(poll)
      if (frame !== 0) window.cancelAnimationFrame(frame)
    }
  }, [rootRef, active])

  // 首帧测量前的兜底：与胶囊右对齐、贴在下方（只在挂载后到 measure() 之间生效）。
  return geometry ?? { side: 'below', left: 120 - TOAST_WIDTH }
}
