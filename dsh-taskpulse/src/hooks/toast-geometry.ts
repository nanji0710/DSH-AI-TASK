/**
 * toast-geometry —— 状态提示弹窗的「贴哪一侧」计算（纯几何，零依赖）。
 *
 * 需求（m04869）：提示弹窗出现在「胶囊的上方或下方」。胶囊可以被拖到窗口内
 * 任意位置（需求 m01719），所以上下哪一侧有地方是**算出来的**，不能写死：
 * 胶囊贴在顶部时上方没有空间，贴在底部时下方没有空间，
 * 而 layout frame 是 `overflow: hidden` —— 露到窗口外的部分直接看不见，
 * 不是「有点难看」而是「完全看不到提示」。
 *
 * 与 panel-geometry.ts 共享同一套语义：
 *   - 先按可容纳性选边，再按「贴着胶囊、但不越出内容区」算水平偏移；
 *   - 复用同一个 `clampToBounds` / `finite`，不另写一套 NaN 规则。
 *
 * 纯函数，边界可直接断言（见 test/toast.test.mjs）。
 */

import { clampToBounds, finite, type Rect } from './panel-geometry'

/** 提示与胶囊之间的间距（与 CSS 里 `.tp-toast` 的偏移一致）。 */
export const TOAST_GAP = 8

/** 提示与窗口边缘的最小留白。 */
export const TOAST_MARGIN = 12

/** 提示宽度（比 360px 的面板窄：它只是一条通知，不该盖住半屏）。 */
export const TOAST_WIDTH = 264

/**
 * 判定「这一侧放得下」所需的高度。
 *
 * 一条提示的实际高度由标题与说明文字决定（约 56px），这里取略大的保守值：
 * 宁可翻到另一侧，也不要把提示卡在窗口边缘被裁掉一半。
 */
export const TOAST_MIN_ROOM = 72

export type ToastSide = 'above' | 'below'

export interface ToastGeometryInput {
  /** 胶囊在视口坐标里的矩形（`.tp-root` 的实测矩形）。 */
  capsule: { left: number; top: number; width: number; height: number }
  /** DSH 内容区（overlayLayer）在视口坐标里的矩形，即窗口可用范围。 */
  overlay: Rect
}

export interface ToastGeometry {
  /** 提示在胶囊上方还是下方。 */
  side: ToastSide
  /**
   * 提示左边缘相对胶囊左边缘的偏移（px，可为负 —— 提示比胶囊宽）。
   *
   * 返回**相对偏移**而不是绝对坐标，是为了它能直接当作内联 style 用：
   * `.tp-root` 就是胶囊本身的位置，提示绝对定位在它内部，
   * 于是之后再拖动胶囊时提示会自己跟着走，无需重算坐标系。
   */
  left: number
}

/**
 * 计算提示的贴边方向与水平偏移。
 *
 * 垂直：优先下方（胶囊默认在右上角，下方空间充裕）；下方放不下且上方更宽松
 * 时翻到上方（胶囊被拖到窗口底部时就靠这条）；两侧都放不下则选宽松的一侧 ——
 * 此时无论选哪边都会溢出，选宽松的一侧至少能让提示的更多部分留在窗口内。
 *
 * 水平：默认与胶囊右对齐（保持右上角的默认观感）；若那样会越出窗口边缘则整体
 * 平移回来（胶囊被拖到窗口左侧时会出现，例如 left = 0 而提示宽 264px）。
 */
export function placeToast(input: ToastGeometryInput): ToastGeometry {
  const capsule = {
    left: finite(input?.capsule?.left),
    top: finite(input?.capsule?.top),
    width: finite(input?.capsule?.width),
    height: finite(input?.capsule?.height)
  }
  const overlay = {
    left: finite(input?.overlay?.left),
    top: finite(input?.overlay?.top),
    width: finite(input?.overlay?.width),
    height: finite(input?.overlay?.height)
  }

  const topLimit = overlay.top + TOAST_MARGIN
  const bottomLimit = overlay.top + overlay.height - TOAST_MARGIN

  const roomBelow = bottomLimit - (capsule.top + capsule.height + TOAST_GAP)
  const roomAbove = capsule.top - TOAST_GAP - topLimit

  let side: ToastSide
  if (roomBelow >= TOAST_MIN_ROOM) side = 'below'
  else if (roomAbove >= TOAST_MIN_ROOM) side = 'above'
  else side = roomBelow >= roomAbove ? 'below' : 'above'

  const wantLeft = capsule.width - TOAST_WIDTH
  const minLeft = overlay.left + TOAST_MARGIN - capsule.left
  const maxLeft = overlay.left + overlay.width - TOAST_MARGIN - TOAST_WIDTH - capsule.left
  const left = maxLeft <= minLeft ? minLeft : minLeft + clampToBounds(wantLeft - minLeft, maxLeft - minLeft)

  return { side, left: finite(left) }
}
