/**
 * use-panel-geometry —— 把 panel-geometry.ts 的纯计算接到真实 DOM 上。
 *
 * 职责只有三件：
 *   1. 量出胶囊与内容区的实时矩形；
 *   2. 调 `computePanelGeometry` 算出面板该放哪、能有多大；
 *   3. 在窗口尺寸变化、胶囊被拖动、面板自身尺寸变化时重算。
 *
 * 为什么必须「实时量」而不是写死：胶囊可被拖到窗口任意位置（需求 m01719），
 * 而面板 600px 高。固定向下展开时，只要胶囊在下半屏，面板就会伸出 layout frame
 * 被 `overflow: hidden` 裁掉 —— 用户看到「点开之后什么都没有」。
 * 裁切发生在 frame 上、位于 `.tp-body` 滚动容器之外，所以滚动救不回来。
 */

import { useEffect, useState, type CSSProperties, type RefObject } from 'react'
import { PANEL_SIZE, computePanelGeometry, readOverlayRect } from './panel-geometry'

export interface PanelGeometryResult {
  placement: 'below' | 'above'
  /** 直接交给 `.tp-panel` 的内联样式（位置 + 尺寸上限）。 */
  style: CSSProperties
}

/**
 * 兜底位置：右对齐、在胶囊正下方。
 *
 * 与旧版 flex 布局的观感一致，只在首次测量完成前生效一帧（useEffect
 * 在浏览器绘制前运行，用户实际看不到这个中间态）。
 * root 宽 120，面板宽 360 ⇒ 右对齐需要左移 240。
 */
const FALLBACK_STYLE: CSSProperties = { top: 40, left: -240 }

export function usePanelGeometry(
  rootRef: RefObject<HTMLElement | null>,
  expanded: boolean
): PanelGeometryResult {
  const [geometry, setGeometry] = useState<PanelGeometryResult | null>(null)

  useEffect(() => {
    if (!expanded) {
      // 收起时清掉，下次展开重新按当前位置量一次。
      setGeometry(null)
      return undefined
    }

    const root = rootRef.current
    if (root === null) return undefined

    let frame = 0
    const measure = (): void => {
      const rect = root.getBoundingClientRect()
      // 注意 `NaN <= 0` 为 false：元素被卸载或祖先 display:none 时会拿到 NaN，
      // 只写 `rect.width <= 0` 拦不住，必须显式要求有限正数。
      if (!Number.isFinite(rect.width) || !Number.isFinite(rect.height) || rect.width <= 0 || rect.height <= 0) {
        return
      }
      const overlay = readOverlayRect(root)
      const next = computePanelGeometry({
        capsule: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
        overlay,
        desired: PANEL_SIZE
      })
      setGeometry((previous) => {
        // 几何未变就不触发重渲染（拖动时每次 pointermove 都会走到这里）。
        if (
          previous !== null &&
          previous.placement === next.placement &&
          previous.style.top === next.offsetTop &&
          previous.style.left === next.offsetLeft &&
          previous.style.maxHeight === next.maxHeight &&
          (previous.style.width as number | undefined) === next.maxWidth
        ) {
          return previous
        }
        return {
          placement: next.placement,
          style: {
            top: next.offsetTop,
            left: next.offsetLeft,
            width: next.maxWidth,
            maxHeight: next.maxHeight
          }
        }
      })
    }

    // 首帧同步量一次（useEffect 在本轮 DOM 变更后、绘制前执行）。
    measure()

    const schedule = (): void => {
      if (frame !== 0) return
      frame = window.requestAnimationFrame(() => {
        frame = 0
        measure()
      })
    }

    window.addEventListener('resize', schedule)
    window.addEventListener('scroll', schedule, true)

    // 胶囊拖动改的是 root 的内联 style，尺寸不变但位置变了；
    // ResizeObserver 抓不到位置变化，所以拖动期间由组件显式调用 `schedule` 更可靠。
    // 这里额外观察 root 的尺寸（窗口缩小时胶囊宽度不变，但内容区会变）。
    let observer: ResizeObserver | undefined
    if (typeof ResizeObserver !== 'undefined') {
      const parent = root.offsetParent as HTMLElement | null
      observer = new ResizeObserver(schedule)
      if (parent !== null) observer.observe(parent)
      observer.observe(root)
    }

    // 拖动中位置持续变化：用 rAF 轮询兜住（只在展开前的拖动会影响初始位置，
    // 展开态胶囊不可拖，所以这里的轮询开销可以忽略）。
    const poll = window.setInterval(schedule, 250)

    return () => {
      window.removeEventListener('resize', schedule)
      window.removeEventListener('scroll', schedule, true)
      window.clearInterval(poll)
      if (frame !== 0) window.cancelAnimationFrame(frame)
      observer?.disconnect()
    }
  }, [expanded, rootRef])

  return geometry ?? { placement: 'below', style: FALLBACK_STYLE }
}
