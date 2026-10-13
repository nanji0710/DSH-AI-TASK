/**
 * useCapsuleDrag —— 让入口胶囊可在 DSH 程序窗口内任意拖动，且**不越界**。
 *
 * 需求原话：「缩小为 AI 任务胶囊状态时，胶囊可在 DSH 程序内任意拖动位置
 * （拖动范围不超出 DSH 程序窗口）。」
 *
 * 实现要点：
 *  1. **边界来自 DOM，不是猜测**：`.tp-root` 是 absolute 定位，它的
 *     `offsetParent` 正是 layout 的 overlayLayer（`position:absolute; inset:0`），
 *     也就是 DSH 的整个内容区。用它测量边界，就无需硬编码标题栏高度 ——
 *     Windows（标题栏预留 40px）、macOS（红绿灯 48px）、全屏三种情况自动正确。
 *  2. **区分「点击」与「拖动」**：位移超过阈值才算拖动，并且**吞掉随后到来的
 *     click 事件**，否则每次拖动结束都会顺带把面板打开/收起。
 *  3. **位置持久化**：拖动结果写进 localStorage，刷新与重启后保持原处。
 *  4. 展开面板时不拖动 —— 需求限定「胶囊状态」，面板区域内拖动会与滚动冲突。
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type RefObject
} from 'react'
// `readOverlayRect` 的唯一实现在 panel-geometry.ts（面板定位也要用同一套测量），
// 这里复用它而不是各自实现一份 —— 两份测量逻辑迟早会漂移。
import { readOverlayRect } from './panel-geometry'

/** 胶囊默认尺寸（UI 规范 2：宽 120px、高 32px）。 */
export const CAPSULE_SIZE = { width: 120, height: 32 } as const

/** 超过这个位移（px）就判定为拖动，而非点击。 */
const DRAG_THRESHOLD = 4

/** 默认位置：右上角，与 UI 规范 2 的「默认态」一致。 */
const DEFAULT_TOP = 'var(--dsh-frame-overlay-top, 20px)'
const DEFAULT_RIGHT = 20

const STORAGE_KEY = 'dsh-taskpulse:position'

export interface CapsulePoint {
  x: number
  y: number
}

export interface CapsuleDragOptions {
  /** `.tp-root` 的 ref，用于测量边界与读取默认位置。 */
  rootRef: RefObject<HTMLElement | null>
  /** 是否允许拖动（收起为胶囊时为 true，展开面板时为 false）。 */
  enabled: boolean
}

export interface CapsuleDragResult {
  /** 拖动后的位置；null = 尚未拖动过，使用 CSS 默认的右上角。 */
  point: CapsulePoint | null
  /** 当前是否正在拖动（用于 cursor 与禁用过渡动画）。 */
  dragging: boolean
  /** 施加到 `.tp-root` 的定位样式。 */
  style: CSSProperties
  /** 可拖动区域（胶囊按钮）的指针事件处理器。 */
  handleProps: {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void
    onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void
  }
  /** 消费一次「刚刚发生了拖动」标记；返回 true 时调用方应忽略本次点击。 */
  consumeDrag: () => boolean
  /** 恢复默认位置（供「重置位置」使用）。 */
  reset: () => void
}

/** 读取 DSH 内容区尺寸：优先用 offsetParent（overlayLayer），兜底用视口。 */
function readBounds(node: HTMLElement | null): { width: number; height: number } {
  const rect = readOverlayRect(node)
  return { width: rect.width, height: rect.height }
}

/**
 * 把坐标钳制在 [0, max] 内，保证胶囊整体留在窗口里。
 *
 * 三种非正常输入的处理刻意不同：
 *  - `NaN` → 0：方向未知，退回左上角默认位（NaN 进 min/max 会传染成 NaN，
 *    进而渲染出非法样式，必须挡住）；
 *  - `+Infinity` → max、`-Infinity` → 0：**朝最近的一侧饱和**，而不是一律归零。
 *    归零会让胶囊从右下「瞬移」到左上，用户看到的是位置丢失；
 *  - `max <= 0`（窗口比胶囊还小时）→ 0：夹到 0 而非负数坐标。
 */
function clamp(value: number, max: number): number {
  if (Number.isNaN(value)) return 0
  if (max <= 0) return 0
  return Math.min(Math.max(0, value), max)
}

export interface Bounds {
  width: number
  height: number
}

/**
 * 把胶囊左上角钳制到「整个胶囊仍在窗口内」的范围。
 *
 * 这是需求「拖动范围不超出 DSH 程序窗口」的唯一实现点，抽成纯函数
 * 以便直接断言边界行为（见 test/drag.test.mjs）。
 *
 * 规则：
 *  - 上下左右都不得越出：[0, 窗口宽 - 胶囊宽] × [0, 窗口高 - 胶囊高]；
 *  - 窗口比胶囊还小时（极端窄窗口）夹到 0，而不是产生负数坐标；
 *  - `NaN` 回落到 0；`±Infinity` 朝最近的一侧饱和（见 clamp 注释）。
 */
export function clampCapsulePoint(
  point: CapsulePoint,
  bounds: Bounds,
  size: { width: number; height: number } = CAPSULE_SIZE
): CapsulePoint {
  return {
    x: clamp(point.x, bounds.width - size.width),
    y: clamp(point.y, bounds.height - size.height)
  }
}

function readStoredPoint(): CapsulePoint | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (raw === null) return null
    const parsed = JSON.parse(raw) as Partial<CapsulePoint>
    if (typeof parsed?.x !== 'number' || typeof parsed?.y !== 'number') return null
    if (!Number.isFinite(parsed.x) || !Number.isFinite(parsed.y)) return null
    return { x: parsed.x, y: parsed.y }
  } catch {
    // 隐私模式 / 存储被禁用 / 内容被外部改写：静默回退到默认位置。
    return null
  }
}

function writeStoredPoint(point: CapsulePoint | null): void {
  try {
    if (point === null) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, JSON.stringify(point))
  } catch {
    // 存不下不影响本次会话内的拖动。
  }
}

export function useCapsuleDrag({ rootRef, enabled }: CapsuleDragOptions): CapsuleDragResult {
  const [point, setPoint] = useState<CapsulePoint | null>(() => readStoredPoint())
  const [dragging, setDragging] = useState(false)

  /** 一次拖动的起始快照：指针位置、胶囊起点、是否已越过阈值。 */
  const sessionRef = useRef<{ pointerX: number; pointerY: number; originX: number; originY: number; moved: boolean } | null>(null)
  /** 拖动结束后置位，由 consumeDrag() 消费，用于吞掉紧随其后的 click。 */
  const draggedRef = useRef(false)

  /** 测出胶囊在 overlay 坐标系里的当前位置（把 CSS 默认值也换算成数字）。 */
  const measureOrigin = useCallback((): CapsulePoint => {
    const node = rootRef.current
    const bounds = readBounds(node)
    if (node === null) return { x: bounds.width - CAPSULE_SIZE.width, y: 0 }
    const rect = node.getBoundingClientRect()
    const parent = node.offsetParent as HTMLElement | null | undefined
    if (parent === null || parent === undefined) return { x: rect.left, y: rect.top }
    const parentRect = parent.getBoundingClientRect()
    return { x: rect.left - parentRect.left, y: rect.top - parentRect.top }
  }, [rootRef])

  const handleProps = useMemo(
    () => ({
      onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
        // 只响应主键 / 触摸 / 笔，且展开面板与禁用时不接管事件。
        if (!enabled) return
        if (event.button !== 0) return
        const origin = measureOrigin()
        sessionRef.current = {
          pointerX: event.clientX,
          pointerY: event.clientY,
          originX: origin.x,
          originY: origin.y,
          moved: false
        }
        try {
          event.currentTarget.setPointerCapture(event.pointerId)
        } catch {
          // 某些环境下无法捕获指针（如元素已被移除），退化为普通拖动。
        }
      },

      onPointerMove: (event: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current
        if (session === null) return
        const dx = event.clientX - session.pointerX
        const dy = event.clientY - session.pointerY
        if (!session.moved && Math.abs(dx) + Math.abs(dy) < DRAG_THRESHOLD) return
        if (!session.moved) {
          session.moved = true
          setDragging(true)
        }
        const bounds = readBounds(rootRef.current)
        setPoint({
          x: clamp(session.originX + dx, bounds.width - CAPSULE_SIZE.width),
          y: clamp(session.originY + dy, bounds.height - CAPSULE_SIZE.height)
        })
      },

      onPointerUp: (event: ReactPointerEvent<HTMLElement>) => {
        const session = sessionRef.current
        sessionRef.current = null
        setDragging(false)
        try {
          event.currentTarget.releasePointerCapture(event.pointerId)
        } catch {
          // 忽略：未成功捕获时释放会抛。
        }
        if (session === null || !session.moved) return
        // 拖动结束：置位标记，吞掉浏览器随后派发的 click。
        draggedRef.current = true
        setPoint((current) => {
          writeStoredPoint(current)
          return current
        })
      },

      onPointerCancel: () => {
        sessionRef.current = null
        setDragging(false)
      }
    }),
    [enabled, measureOrigin, rootRef]
  )

  const consumeDrag = useCallback(() => {
    if (!draggedRef.current) return false
    draggedRef.current = false
    return true
  }, [])

  const reset = useCallback(() => {
    setPoint(null)
    writeStoredPoint(null)
  }, [])

  /** 窗口尺寸变化后重新钳制，避免窗口缩小后胶囊被留在可视区之外。 */
  useEffect(() => {
    const onResize = () => {
      setPoint((current) => {
        if (current === null) return current
        const bounds = readBounds(rootRef.current)
        const next = {
          x: clamp(current.x, bounds.width - CAPSULE_SIZE.width),
          y: clamp(current.y, bounds.height - CAPSULE_SIZE.height)
        }
        if (next.x === current.x && next.y === current.y) return current
        writeStoredPoint(next)
        return next
      })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [rootRef])

  // ⚠️ 存储里的位置可能来自「窗口比现在大」的那次会话，首次挂载即钳制一次。
  useEffect(() => {
    const onMount = () => {
      setPoint((current) => {
        if (current === null) return current
        const bounds = readBounds(rootRef.current)
        const next = {
          x: clamp(current.x, bounds.width - CAPSULE_SIZE.width),
          y: clamp(current.y, bounds.height - CAPSULE_SIZE.height)
        }
        return next.x === current.x && next.y === current.y ? current : next
      })
    }
    onMount()
  }, [rootRef])

  const style = useMemo<CSSProperties>(() => {
    if (point === null) {
      // 未拖动过：沿用 UI 规范 2 的默认右上角，由 CSS 变量自动避让标题栏。
      return { top: DEFAULT_TOP, right: DEFAULT_RIGHT }
    }
    return {
      top: point.y,
      left: point.x,
      right: 'auto',
      // 拖动过程中禁用过渡，否则胶囊会「追」着指针走。
      transition: dragging ? 'none' : undefined
    }
  }, [point, dragging])

  return { point, dragging, style, handleProps, consumeDrag, reset }
}
