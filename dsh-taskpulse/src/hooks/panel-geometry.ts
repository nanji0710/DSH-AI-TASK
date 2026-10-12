/**
 * panel-geometry —— 展开面板的「定位与尺寸计算」（纯几何，零依赖）。
 *
 * 为什么需要它：面板是 360x600 的固定尺寸，而胶囊可以被拖到窗口内任意位置
 * （需求 m01719）。如果面板永远从胶囊正下方展开，那么只要胶囊处于窗口下半部，
 * 600px 高的面板就会伸出窗口，被 layout frame 的 `overflow: hidden` 裁掉 ——
 * 用户看到的是「点开之后什么都没有，还得把胶囊拖回去」。裁切发生在 frame 上，
 * 位于 `.tp-body` 的滚动容器之外，所以**滚动救不回来**。
 *
 * 因此面板的位置与最大高度必须由胶囊的实时位置和窗口可用空间算出来：
 *   1. 垂直：优先向下展开；下方放不下时，若上方更宽松就翻到上方；
 *      两侧都放不下就选宽的一侧，并把 max-height 压到可用空间（由 `.tp-body` 内部滚动）。
 *   2. 水平：默认与胶囊右对齐（保持右上角的默认观感），越界则整体平移回来，
 *      最后用 max-width 兜住窄窗口。
 *
 * 做成不依赖 DOM 的纯函数，是为了让边界行为可以被直接断言
 * （见 test/panel.test.mjs）—— 这类「差几像素就看不见」的缺陷
 * 靠肉眼在 GUI 里试是试不全的。
 */

/** 视口坐标矩形。 */
export interface Rect {
  left: number
  top: number
  width: number
  height: number
}

/** 面板期望尺寸（UI 规范 3：宽 360px、高 600px）。 */
export const PANEL_SIZE = { width: 360, height: 600 } as const

/** 面板与胶囊之间的间距。 */
export const PANEL_GAP = 8

/** 面板与窗口边缘的最小留白。 */
export const PANEL_MARGIN = 12

/**
 * 极端窄/矮窗口下的最小可读高度。
 * 低于这个值面板只剩边框，还不如让它略微溢出 —— 但正常窗口永远到不了这里。
 */
export const PANEL_MIN_HEIGHT = 180

export interface PanelGeometryInput {
  /** 胶囊在视口坐标里的矩形（`.tp-root` 的实测矩形）。 */
  capsule: { left: number; top: number; width: number; height: number }
  /** DSH 内容区（overlayLayer）在视口坐标里的矩形。 */
  overlay: Rect
  /** 面板期望尺寸。 */
  desired: { width: number; height: number }
  gap?: number
  margin?: number
  minHeight?: number
}

export interface PanelGeometry {
  /** 面板在胶囊下方还是上方展开。 */
  placement: 'below' | 'above'
  /** 面板可用最大高度（px）。实际高度 = min(期望高度, 该值)。 */
  maxHeight: number
  /** 面板可用最大宽度（px）。 */
  maxWidth: number
  /** 面板左边缘相对胶囊左边缘的偏移（供 absolute 定位使用，可为负）。 */
  offsetLeft: number
  /** 面板上边缘相对胶囊上边缘的偏移（上方展开时为负）。 */
  offsetTop: number
}

/**
 * 读取 DSH 内容区（overlayLayer）在视口坐标里的矩形。
 *
 * `.tp-root` 是 absolute 定位，其 `offsetParent` 正是 layout 的 overlayLayer
 * （`position:absolute; inset:0`）。用它测量比 `window.innerWidth/Height` 准确：
 * 已经排除了 macOS 红绿灯区与 Windows 标题栏预留，无需硬编码避让高度。
 * 量不到时兜底视口，保证任何环境下都有可用边界。
 */
export function readOverlayRect(node: HTMLElement | null): Rect {
  const parent = node?.offsetParent as HTMLElement | null | undefined
  if (parent !== null && parent !== undefined) {
    const rect = parent.getBoundingClientRect()
    if (rect.width > 0 && rect.height > 0) {
      return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
    }
  }
  return { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight }
}

/**
 * 把坐标夹进 [0, max]，保证元素整体留在边界内。
 *
 * 三种非正常输入的处理刻意不同（胶囊拖动与面板定位必须遵守同一套语义，
 * 否则同一个位置在拖动与展开时会得到不同结果）：
 *  - `NaN` → 0：方向未知，退回左上角默认位。NaN 进 min/max 会传染成 NaN，
 *    最终渲染出非法样式（`left: NaNpx` 会被浏览器整条丢弃）；
 *  - `+Infinity` → max、`-Infinity` → 0：**朝最近的一侧饱和**，而不是一律归零。
 *    归零会让元素从右下「瞬移」到左上，用户看到的是位置丢失；
 *  - `max <= 0`（边界比元素还小）→ 0：夹到 0 而非负数坐标。
 */
export function clampToBounds(value: number, max: number): number {
  if (Number.isNaN(value)) return 0
  if (max <= 0) return 0
  return Math.min(Math.max(0, value), max)
}

/**
 * 把任意输入收敛成有限数。
 *
 * `getBoundingClientRect()` 在元素被卸载、或处在 `display: none` 的祖先下时
 * 会返回 NaN。NaN 一旦进入 `panelLeft - capsule.left`，最终会写出
 * `left: NaNpx` —— 浏览器直接丢弃该声明，面板回到 CSS 默认位置（左上角），
 * 看起来就是「面板莫名跑掉了」。宁可退化成 0 也不要产生非法样式。
 */
function finite(value: number, fallback = 0): number {
  return Number.isFinite(value) ? value : fallback
}

/**
 * 计算面板的展开位置与可用尺寸。
 *
 * 保证：在胶囊位于窗口内任意位置时，面板都完整落在内容区内
 * （除非窗口本身比最小可读高度还矮）。
 */
export function computePanelGeometry(input: PanelGeometryInput): PanelGeometry {
  const gap = input.gap ?? PANEL_GAP
  const margin = input.margin ?? PANEL_MARGIN
  const minHeight = input.minHeight ?? PANEL_MIN_HEIGHT
  const { desired } = input

  // 先净化输入：所有后续算术都建立在有限数上（见 finite 的说明）。
  const capsule = {
    left: finite(input.capsule.left),
    top: finite(input.capsule.top),
    width: finite(input.capsule.width),
    height: finite(input.capsule.height)
  }
  const overlay = {
    left: finite(input.overlay.left),
    top: finite(input.overlay.top),
    width: finite(input.overlay.width),
    height: finite(input.overlay.height)
  }
  const wantWidth = finite(desired.width)
  const wantHeight = finite(desired.height)

  // ---- 水平：默认与胶囊右对齐，越界就整体平移回来 ----
  const maxWidth = Math.max(0, Math.min(wantWidth, overlay.width - margin * 2))
  const capsuleRight = capsule.left + capsule.width
  const minLeft = overlay.left + margin
  const maxLeft = overlay.left + overlay.width - margin - maxWidth
  // 右对齐是默认观感（与 UI 规范 2 的右上角入口一致）：面板右边缘贴胶囊右边缘。
  let panelLeft = capsuleRight - maxWidth
  if (panelLeft < minLeft) panelLeft = minLeft
  if (panelLeft > maxLeft) panelLeft = maxLeft

  // ---- 垂直：优先向下，下方不足且上方更宽松时翻上去 ----
  const overlayBottom = overlay.top + overlay.height
  const availableBelow = overlayBottom - margin - (capsule.top + capsule.height + gap)
  const availableAbove = capsule.top - gap - margin - overlay.top
  const fitHeight = (value: number): number => Math.max(minHeight, Math.min(wantHeight, finite(value)))

  let placement: 'below' | 'above'
  let maxHeight: number
  if (availableBelow >= wantHeight) {
    placement = 'below'
    maxHeight = wantHeight
  } else if (availableAbove >= wantHeight) {
    placement = 'above'
    maxHeight = wantHeight
  } else if (availableBelow >= availableAbove) {
    placement = 'below'
    maxHeight = fitHeight(availableBelow)
  } else {
    placement = 'above'
    maxHeight = fitHeight(availableAbove)
  }

  const offsetLeft = finite(panelLeft - capsule.left)
  const offsetTop = finite(placement === 'below' ? capsule.height + gap : -(maxHeight + gap))
  return { placement, maxHeight, maxWidth, offsetLeft, offsetTop }
}

/**
 * 胶囊位置钳制：保证整个胶囊留在内容区内（需求 m01719）。
 *
 * ⚠️ 这里只做「相对内容区左上角」的钳制；真实拖动还要叠加 `overlay.left/top`
 * 的视口偏移，因此 `use-capsule-drag` 用的是自己的 `clampCapsulePoint`
 * （接收的是内容区尺寸而非矩形）。两者共享同一个 `clampToBounds` 语义，
 * 数值行为不会分叉。
 */
export function clampWithinOverlay(
  point: { x: number; y: number },
  overlay: Rect,
  size: { width: number; height: number }
): { x: number; y: number } {
  return {
    x: clampToBounds(point.x, overlay.width - size.width),
    y: clampToBounds(point.y, overlay.height - size.height)
  }
}
