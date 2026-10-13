/**
 * 展开面板的定位与尺寸契约自检。
 *
 * 用户报的缺陷原话：「有时点击后列表超出了屏幕范围、导致看不见内容、还需要额外拖动」。
 *
 * 根因：面板曾是胶囊的 flex 兄弟节点，永远从胶囊正下方展开。胶囊可被拖到窗口
 * 任意位置（需求 m01719），而面板高 600px —— 胶囊一旦进入下半屏，面板就伸出
 * DSH 内容区，被 layout frame 的 `overflow: hidden` 裁掉。裁切发生在 frame 上，
 * 位于 `.tp-body` 滚动容器**之外**，所以滚动救不回来，只能靠外部拖动。
 *
 * 修法是把几何计算抽成纯函数 `computePanelGeometry`：面板改为绝对定位，
 * 位置与最大高度按「胶囊实时位置 + 窗口可用空间」算出。纯函数才能在这里
 * 穷举边界 —— 这类「差几像素就看不见」的缺陷靠肉眼在 GUI 里试是试不全的。
 *
 * 运行：npm run test:panel
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

const outdir = join(process.cwd(), 'node_modules', '.taskpulse-panel-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['src/hooks/panel-geometry.ts'],
  bundle: true,
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'warning'
})

const { computePanelGeometry, clampWithinOverlay, PANEL_SIZE, PANEL_GAP, PANEL_MARGIN } = require(
  join(outdir, 'panel-geometry.cjs')
)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

/** DSH 内容区（Windows 1280x800 减去标题栏等后的近似值）。 */
const OVERLAY = { left: 0, top: 40, width: 1200, height: 720 }
const CAPSULE = { width: 120, height: 32 }

/** 用胶囊左上角坐标算出几何结果。 */
function geometryAt(left, top, overlay = OVERLAY) {
  return computePanelGeometry({
    capsule: { left, top, width: CAPSULE.width, height: CAPSULE.height },
    overlay,
    desired: PANEL_SIZE
  })
}

/** 面板在视口坐标里的矩形（由偏移量还原）。 */
function panelRect(left, top, overlay = OVERLAY) {
  const geometry = geometryAt(left, top, overlay)
  return {
    left: left + geometry.offsetLeft,
    top: top + geometry.offsetTop,
    right: left + geometry.offsetLeft + geometry.maxWidth,
    bottom: top + geometry.offsetTop + geometry.maxHeight,
    geometry
  }
}

/** 不变式：面板必须完整落在内容区内。 */
function assertInsideOverlay(left, top, overlay = OVERLAY, label = '') {
  const rect = panelRect(left, top, overlay)
  const suffix = label === '' ? '' : `（${label}）`
  assert.ok(
    rect.left >= overlay.left + PANEL_MARGIN - 0.001,
    `左边缘越界${suffix}：${rect.left} < ${overlay.left + PANEL_MARGIN}`
  )
  assert.ok(
    rect.right <= overlay.left + overlay.width - PANEL_MARGIN + 0.001,
    `右边缘越界${suffix}：${rect.right} > ${overlay.left + overlay.width - PANEL_MARGIN}`
  )
  assert.ok(
    rect.top >= overlay.top + PANEL_MARGIN - 0.001,
    `上边缘越界${suffix}：${rect.top} < ${overlay.top + PANEL_MARGIN}`
  )
  assert.ok(
    rect.bottom <= overlay.top + overlay.height - PANEL_MARGIN + 0.001,
    `下边缘越界${suffix}：${rect.bottom} > ${overlay.top + overlay.height - PANEL_MARGIN}`
  )
  return rect
}

console.log('面板尺寸与常量：')

check('面板尺寸符合 UI 规范 3（360x600）', () => {
  assert.equal(PANEL_SIZE.width, 360)
  assert.equal(PANEL_SIZE.height, 600)
})

check('面板与胶囊、窗口边缘的间距是显式常量', () => {
  assert.ok(PANEL_GAP > 0 && PANEL_GAP <= 16, `间距 ${PANEL_GAP} 不合理`)
  assert.ok(PANEL_MARGIN >= 8 && PANEL_MARGIN <= 24, `留白 ${PANEL_MARGIN} 不合理`)
})

console.log('垂直：胶囊在窗口上方时向下展开：')

check('胶囊靠近顶部：向下展开，且保持完整 600px 高', () => {
  const geometry = geometryAt(1000, 60)
  assert.equal(geometry.placement, 'below')
  assert.equal(geometry.maxHeight, PANEL_SIZE.height)
  // 向下展开＝面板上边缘在胶囊下边缘 + 间距处。
  assert.equal(geometry.offsetTop, CAPSULE.height + PANEL_GAP)
})

check('胶囊在下半屏：翻到胶囊上方展开（这是用户报告缺陷的核心修复）', () => {
  // 内容区底 760，胶囊在 y=700 ⇒ 下方只剩 760-12-(700+32+8)=8px，远不够 600。
  const geometry = geometryAt(1000, 700)
  assert.equal(geometry.placement, 'above')
  assert.equal(geometry.maxHeight, PANEL_SIZE.height)
  // 上方展开＝面板下边缘在胶囊上边缘 - 间距处 ⇒ 偏移为负。
  assert.ok(geometry.offsetTop < 0, `上方展开的偏移应为负，实际 ${geometry.offsetTop}`)
  assert.equal(geometry.offsetTop, -(PANEL_SIZE.height + PANEL_GAP))
})

check('窗口很矮时压缩高度，而不是把面板推出窗口', () => {
  // 内容区只有 400 高，胶囊贴底 ⇒ 上方可用 400-12-(380+8)-40... 总之两侧都不够 600。
  const overlay = { left: 0, top: 40, width: 1200, height: 400 }
  const geometry = geometryAt(1000, 380, overlay)
  assert.ok(geometry.maxHeight < PANEL_SIZE.height, '高度应被压缩')
  assert.ok(geometry.maxHeight >= 180, `压缩后仍应可读，实际 ${geometry.maxHeight}`)
  assertInsideOverlay(1000, 380, overlay, '矮窗口')
})

check('两侧都不够时选更宽松的一侧（不盲目向上）', () => {
  const overlay = { left: 0, top: 0, width: 1200, height: 700 }
  // 胶囊在 y=60：上方 60-8-12=40，下方 700-12-100=588 ⇒ 应选下方。
  const geometry = geometryAt(1000, 60, overlay)
  assert.equal(geometry.placement, 'below')
})

console.log('水平：默认右对齐，越界平移回来：')

check('默认与胶囊右对齐（延续右上角入口的观感）', () => {
  const geometry = geometryAt(1000, 60)
  // 胶囊右边缘 1120，面板左边缘 = 1120 - 360 = 760 ⇒ 相对胶囊左边缘偏移 -240。
  assert.equal(geometry.offsetLeft, -240)
})

check('胶囊贴左边缘：面板被平移回窗口内，而不是左半边被切掉', () => {
  const rect = assertInsideOverlay(0, 60, OVERLAY, '胶囊贴左')
  assert.ok(rect.geometry.offsetLeft > 0, '面板应向右平移回来')
})

check('胶囊贴右边缘：面板不越出右侧', () => {
  assertInsideOverlay(OVERLAY.width - CAPSULE.width, 60, OVERLAY, '胶囊贴右')
})

check('窗口比面板窄时用 maxWidth 兜住，绝不横向溢出', () => {
  const overlay = { left: 0, top: 40, width: 320, height: 720 }
  const geometry = geometryAt(180, 60, overlay)
  assert.ok(geometry.maxWidth <= overlay.width - PANEL_MARGIN * 2, `maxWidth ${geometry.maxWidth} 过宽`)
  assertInsideOverlay(180, 60, overlay, '窄窗口')
})

console.log('回归：任意胶囊位置下面板都完整可见（用户报告的缺陷）：')

check('遍历内容区网格：缩放到窗口后每个位置的偏移都合法', () => {
  const xs = [0, 120, 300, 600, 840, OVERLAY.width - CAPSULE.width]
  // ⚠️ 胶囊坐标是**视口坐标**（来自 getBoundingClientRect），因此 y 的下界是
  // overlay.top 而不是 0 —— 胶囊被钳制在内容区内，永远到不了标题栏之上。
  const ys = [
    OVERLAY.top,
    OVERLAY.top + 40,
    200,
    400,
    560,
    OVERLAY.top + OVERLAY.height - CAPSULE.height
  ]
  for (const x of xs) {
    for (const y of ys) {
      assertInsideOverlay(x, y, OVERLAY, `胶囊(${x},${y})`)
    }
  }
})

check('关键回归：胶囊贴内容区右下角时，面板不再被窗口裁掉', () => {
  // 修复前面板只能向下展开，此处会得到 bottom = 692+608 = 1300 ⋙ 760。
  const rect = assertInsideOverlay(
    OVERLAY.width - CAPSULE.width,
    OVERLAY.height - CAPSULE.height,
    OVERLAY,
    '右下角'
  )
  assert.equal(rect.geometry.placement, 'above', '贴底时应向上展开')
})

check('退化输入不产生 NaN/Infinity 样式（NaN 会渲染成非法 CSS）', () => {
  const geometry = computePanelGeometry({
    capsule: { left: Number.NaN, top: Number.NaN, width: CAPSULE.width, height: CAPSULE.height },
    overlay: { left: 0, top: 0, width: 0, height: 0 },
    desired: PANEL_SIZE
  })
  for (const key of ['offsetLeft', 'offsetTop', 'maxHeight', 'maxWidth']) {
    assert.ok(Number.isFinite(geometry[key]), `${key} 应为有限数，实际 ${geometry[key]}`)
  }
  assert.ok(geometry.maxHeight >= 0 && geometry.maxWidth >= 0)
})

console.log('胶囊钳制（与 use-capsule-drag 共用语义）：')

check('clampWithinOverlay 保证胶囊整体在内容区内', () => {
  const result = clampWithinOverlay({ x: 1e6, y: -1e6 }, OVERLAY, CAPSULE)
  assert.equal(result.x, OVERLAY.width - CAPSULE.width)
  assert.equal(result.y, 0)
})

check('clampWithinOverlay 对 NaN 回落 0，不产生非法坐标', () => {
  const result = clampWithinOverlay({ x: Number.NaN, y: Number.NaN }, OVERLAY, CAPSULE)
  assert.deepEqual(result, { x: 0, y: 0 })
})

console.log(`\n全部 ${passed} 项通过。`)
