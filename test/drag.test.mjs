/**
 * 拖动边界契约自检。
 *
 * 用户要求：「胶囊可在 DSH 程序内任意拖动位置（**拖动范围不超出 DSH 程序窗口**）。」
 *
 * 括号里那句才是真正会被做错的部分：一个只做 `left = pointerX` 的实现看起来
 * 能拖，但可以把胶囊拖到屏幕外（拖出去容易，拖回来很难 —— 胶囊看不见就点不到）。
 * 因此把钳制逻辑抽成纯函数 `clampCapsulePoint` 直接断言边界。
 *
 * 同时校验 hook 源码里的两条关键约定，因为它们决定「拖动」不会退化成「误点击」：
 *  - 位移阈值判定（不能让 1px 抖动吞掉正常的展开点击）；
 *  - 拖动结束后吞掉随后到来的 click。
 *
 * 运行：npm run test:drag
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

// ---- 1. 把 hook 打成 CJS 以便直接调用纯函数 ----
const outdir = join(process.cwd(), 'node_modules', '.taskpulse-drag-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['src/hooks/use-capsule-drag.ts'],
  bundle: true,
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  jsx: 'automatic',
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'warning'
})

const { clampCapsulePoint, CAPSULE_SIZE } = require(join(outdir, 'use-capsule-drag.cjs'))

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

/** 典型的 DSH 窗口内容区（Windows 1280x800 减去侧栏后的近似值）。 */
const WINDOW = { width: 1200, height: 720 }

console.log('拖动边界：')

check('胶囊尺寸符合 UI 规范 2（120x32）', () => {
  assert.equal(CAPSULE_SIZE.width, 120)
  assert.equal(CAPSULE_SIZE.height, 32)
})

check('窗口内的坐标原样保留（可拖到任意位置）', () => {
  const point = { x: 400, y: 300 }
  assert.deepEqual(clampCapsulePoint(point, WINDOW), point)
  // 四个角都能到达（含右下极限位）。
  assert.deepEqual(clampCapsulePoint({ x: 0, y: 0 }, WINDOW), { x: 0, y: 0 })
  assert.deepEqual(clampCapsulePoint({ x: WINDOW.width - 120, y: WINDOW.height - 32 }, WINDOW), {
    x: WINDOW.width - 120,
    y: WINDOW.height - 32
  })
})

check('向右/向下越界时被拉回，胶囊整体仍在窗口内', () => {
  const result = clampCapsulePoint({ x: 99999, y: 99999 }, WINDOW)
  assert.equal(result.x, WINDOW.width - CAPSULE_SIZE.width)
  assert.equal(result.y, WINDOW.height - CAPSULE_SIZE.height)
  // 关键不变式：右边缘与下边缘不得超出窗口。
  assert.ok(result.x + CAPSULE_SIZE.width <= WINDOW.width)
  assert.ok(result.y + CAPSULE_SIZE.height <= WINDOW.height)
})

check('向左/向上越界时夹到 0，不产生负坐标', () => {
  assert.deepEqual(clampCapsulePoint({ x: -500, y: -500 }, WINDOW), { x: 0, y: 0 })
})

check('窗口比胶囊还窄时夹到 0（而不是负数坐标）', () => {
  const tiny = { width: 80, height: 20 }
  assert.deepEqual(clampCapsulePoint({ x: 50, y: 50 }, tiny), { x: 0, y: 0 })
})

check('异常坐标：NaN 回落左上角，±Infinity 朝最近的一侧饱和', () => {
  assert.deepEqual(clampCapsulePoint({ x: Number.NaN, y: Number.NaN }, WINDOW), { x: 0, y: 0 })
  // 无穷大不应该让胶囊「瞬移」到对角，而应贴到它所指的那一侧。
  assert.deepEqual(clampCapsulePoint({ x: Number.POSITIVE_INFINITY, y: Number.NEGATIVE_INFINITY }, WINDOW), {
    x: WINDOW.width - CAPSULE_SIZE.width,
    y: 0
  })
})

check('遍历窗口四边：任意极端拖动后胶囊都完整可见（回归用户报告的风险）', () => {
  const extremes = [
    { x: -1e6, y: -1e6 },
    { x: 1e6, y: -1e6 },
    { x: -1e6, y: 1e6 },
    { x: 1e6, y: 1e6 },
    { x: 0, y: 1e6 },
    { x: 1e6, y: 0 }
  ]
  for (const raw of extremes) {
    const point = clampCapsulePoint(raw, WINDOW)
    assert.ok(point.x >= 0 && point.y >= 0, `负坐标：${JSON.stringify(point)}`)
    assert.ok(point.x + CAPSULE_SIZE.width <= WINDOW.width, `右侧越界：${JSON.stringify(point)}`)
    assert.ok(point.y + CAPSULE_SIZE.height <= WINDOW.height, `下方越界：${JSON.stringify(point)}`)
  }
})

check('边界随窗口尺寸变化（同一坐标在小窗口被钳制、在大窗口保持）', () => {
  const point = { x: 700, y: 400 }
  const small = clampCapsulePoint(point, { width: 400, height: 300 })
  const large = clampCapsulePoint(point, { width: 1600, height: 900 })
  assert.deepEqual(small, { x: 400 - CAPSULE_SIZE.width, y: 300 - CAPSULE_SIZE.height })
  assert.deepEqual(large, point)
})

// ---- 2. hook 源码里的行为约定（渲染期无法断言的部分） ----
console.log('拖动交互约定：')

const hookSource = readFileSync(join(process.cwd(), 'src', 'hooks', 'use-capsule-drag.ts'), 'utf8')

check('位移超过阈值才算拖动（1px 抖动不吞掉展开点击）', () => {
  const match = hookSource.match(/DRAG_THRESHOLD\s*=\s*(\d+)/)
  assert.ok(match !== null, '缺少 DRAG_THRESHOLD 定义')
  const threshold = Number(match[1])
  assert.ok(threshold >= 2 && threshold <= 8, `阈值 ${threshold} 不在合理区间 [2,8]`)
})

check('拖动结束后吞掉随后到来的 click（否则一拖就展开）', () => {
  assert.ok(/consumeDrag/.test(hookSource), 'hook 必须暴露 consumeDrag 供调用方忽略这次点击')
  assert.ok(/suppressClick|sawDrag|draggedRef|dragRef/.test(hookSource), 'hook 必须记录「刚刚拖动过」的状态')
})

check('位置写入 localStorage 持久化（刷新后保持原位）', () => {
  assert.ok(/localStorage/.test(hookSource), 'hook 必须持久化位置')
  assert.ok(/dsh-taskpulse:position/.test(hookSource), '存储键应为 dsh-taskpulse:position')
})

check('边界取自 overlayLayer（offsetParent），不硬编码标题栏高度', () => {
  assert.ok(/offsetParent/.test(hookSource), '边界应量测 offsetParent')
  assert.ok(!/40\s*\+\s*20/.test(hookSource), '不得硬编码 Windows 标题栏高度')
})

check('窗口尺寸变化时重新钳制，避免胶囊被留在可视区外', () => {
  assert.ok(/resize/.test(hookSource), 'hook 必须监听 resize 重新钳制')
})

// ---- 3. 标题栏透传豁免（2.0.0） ----
// Windows 标题栏整条横带是 -webkit-app-region: drag（宿主 .frame:before），
// Chromium 把 drag 区域内的鼠标事件全部交给系统移窗，DOM 收不到；
// 子元素必须显式 no-drag 才能豁免。胶囊拖进标题栏带后若缺这条声明，
// 点击/拖动会整个透传到下一层（用户报告的失效现场）。
console.log('标题栏透传豁免：')

const cssSource = readFileSync(join(process.cwd(), 'src', 'styles', 'taskpulse-css.ts'), 'utf8')

/** 取某选择器规则块的声明体（首个 `{` 到配对 `}`，CSS 里没有嵌套块）。 */
function ruleBody(selector) {
  const match = cssSource.match(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}'))
  return match === null ? null : match[1]
}

for (const selector of ['.tp-root', '.tp-btn', '.tp-panel', '.tp-toasts']) {
  check(`${selector} 声明 -webkit-app-region: no-drag（标题栏带内可交互）`, () => {
    const body = ruleBody(selector)
    assert.ok(body !== null, `缺少 ${selector} 规则块`)
    assert.ok(/-webkit-app-region:\s*no-drag/.test(body), `${selector} 必须豁免系统移窗拖动区`)
  })
}

check('no-drag 豁免恰好覆盖四类浮层（新浮层必须同步补声明）', () => {
  // 剥掉 /* */ 注释再数，避免文件头说明文字里的属性名被误计入。
  const css = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')
  const count = (css.match(/-webkit-app-region:\s*no-drag/g) ?? []).length
  assert.equal(count, 4, `期望 4 处 no-drag（root/btn/panel/toasts），实际 ${count}`)
})

console.log(`\n全部 ${passed} 项通过。`)
