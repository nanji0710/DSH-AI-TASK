/**
 * 状态变迁提示（需求 m04869）的自检。
 *
 * 需求原话：「当某个任务新进入一个状态时（例如从运行变为确认、从运行变为完成），
 * 如果当前处于胶囊状态，就在胶囊的上方或下方弹出一个提示弹窗，5 秒后自动消失。」
 *
 * 这里覆盖需求的三条，全部落在纯函数上（判定与 UI 分离，见
 * src/models/status-transition.ts 的文件头）：
 *
 *   1. 状态变迁触发 —— `diffStatuses` 的账本比对。重点在**不该弹的时候别弹**：
 *      首次观测、状态没变、回到 RUNNING、任务消失，四种情况都必须静默；
 *   2. 胶囊态判定 —— `enabled` 由 client/index.tsx 传 `!expanded`。
 *      这里断言的是「提示队列本身与胶囊态无关地正确」，胶囊态门控在
 *      use-status-toasts 的 effect 里（一行 `if (!enabledRef.current) return`），
 *      用真值表锁住它对 toastworthy 的影响，避免有人日后把它挪到 diff 之前，
 *      那样会让账本漏记、展开期间的变迁被补报一遍；
 *   3. 5 秒自动消失 —— `pruneToasts` 按时间戳剔除。
 *      必须能用假时钟穷举边界，否则「5 秒」只能靠秒表在 GUI 里数。
 *
 * 位置计算（上方/下方）用 `placeToast` 穷举，它和面板定位共享同一套 clamp 语义。
 *
 * 运行：npm run test:toast
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

const outdir = join(process.cwd(), 'node_modules', '.taskpulse-toast-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['src/models/status-transition.ts', 'src/hooks/toast-geometry.ts'],
  bundle: true,
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'warning'
})

// ⚠️ 多入口构建会保留源码目录结构（models/…、hooks/…），不是平铺在 outdir 下。
const {
  TOAST_TTL_MS,
  TOAST_LIMIT,
  TOAST_STATUSES,
  admitTransitions,
  diffStatuses,
  isToastworthy,
  mergeToasts,
  pruneToasts,
  transitionText
} = require(join(outdir, 'models', 'status-transition.cjs'))

const { placeToast, TOAST_WIDTH, TOAST_GAP, TOAST_MIN_ROOM } = require(
  join(outdir, 'hooks', 'toast-geometry.cjs')
)

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

/** 一条任务（只用到 id/title/status 三个字段）。 */
function task(sessionId, status, title = `会话 ${sessionId}`) {
  return { sessionId, title, status }
}

/** DSH 内容区（1280x800 减去标题栏等后的近似值），与 panel.test.mjs 保持同口径。 */
const OVERLAY = { left: 0, top: 40, width: 1200, height: 720 }
/** 胶囊 120x32（与 CAPSULE_SIZE / UI 规范 3 一致）。 */
const CAPSULE = { left: 1060, top: 60, width: 120, height: 32 }

console.log('\n状态变迁提示：引擎判定')

check('首次观测只记账、不提示（刚加载不该把已有状态重播一遍）', () => {
  const ledger = new Map()
  const out = diffStatuses(ledger, [task('s1', 'RUNNING'), task('s2', 'WAIT_CONFIRM')], 1000)
  assert.deepEqual(out, [])
  // 账本已建立：下一次才可能报变迁。
  assert.equal(ledger.get('s1'), 'RUNNING')
  assert.equal(ledger.get('s2'), 'WAIT_CONFIRM')
})

check('运行 → 待确认 报一次变迁（需求原话的第一个例子）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 1000)
  const out = diffStatuses(ledger, [task('s1', 'WAIT_CONFIRM')], 2000)
  assert.equal(out.length, 1)
  assert.equal(out[0].sessionId, 's1')
  assert.equal(out[0].from, 'RUNNING')
  assert.equal(out[0].to, 'WAIT_CONFIRM')
  assert.equal(out[0].at, 2000)
})

check('运行 → 完成 报一次变迁（需求原话的第二个例子）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 1000)
  const out = diffStatuses(ledger, [task('s1', 'SUCCESS')], 2000)
  assert.equal(out.length, 1)
  assert.equal(out[0].to, 'SUCCESS')
})

check('状态没变不提示（每次轮询都会重新比对一遍）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 1000)
  // 宿主半边每 2-5 秒轮询一次：状态不变时必须完全静默。
  for (let i = 0; i < 5; i += 1) {
    assert.deepEqual(diffStatuses(ledger, [task('s1', 'RUNNING')], 2000 + i), [])
  }
})

check('回到 RUNNING / START 记账但不出声（否则每次动作都弹窗）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'SUCCESS')], 1000)
  const back = diffStatuses(ledger, [task('s1', 'RUNNING')], 2000)
  assert.deepEqual(back, [])
  // 但账本要更新：否则下一轮 SUCCESS 会拿旧基准比对。
  assert.equal(ledger.get('s1'), 'RUNNING')
  const again = diffStatuses(ledger, [task('s1', 'SUCCESS')], 3000)
  assert.equal(again.length, 1)
  assert.equal(again[0].from, 'RUNNING')
})

check('不值得提示的状态集合是明确列举的（不是「除了运行都弹」的隐式规则）', () => {
  assert.deepEqual(TOAST_STATUSES.slice().sort(), ['BLOCKED', 'ERROR', 'SUCCESS', 'WAIT_CONFIRM'])
  assert.equal(isToastworthy('RUNNING'), false)
  assert.equal(isToastworthy('START'), false)
  assert.equal(isToastworthy('WAIT_CONFIRM'), true)
  assert.equal(isToastworthy('SUCCESS'), true)
  assert.equal(isToastworthy('ERROR'), true)
  assert.equal(isToastworthy('BLOCKED'), true)
})

check('任务消失只清账本、不报变迁（归档 / 删除不是状态变迁）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING'), task('s2', 'ERROR')], 1000)
  const out = diffStatuses(ledger, [task('s1', 'RUNNING')], 2000)
  assert.deepEqual(out, [])
  assert.equal(ledger.has('s2'), false)
})

check('重新出现的会话按首次观测处理（宁可少提示，也不补报陈旧变迁）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'ERROR')], 1000)
  diffStatuses(ledger, [], 2000)
  const out = diffStatuses(ledger, [task('s1', 'ERROR')], 3000)
  assert.deepEqual(out, [])
})

check('一次比对可同时报多条（多任务并行收尾）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING'), task('s2', 'RUNNING'), task('s3', 'RUNNING')], 1000)
  const out = diffStatuses(
    ledger,
    [task('s1', 'SUCCESS'), task('s2', 'WAIT_CONFIRM'), task('s3', 'RUNNING')],
    2000
  )
  assert.deepEqual(
    out.map((item) => `${item.sessionId}:${item.to}`),
    ['s1:SUCCESS', 's2:WAIT_CONFIRM']
  )
})

check('畸形任务不 panic（缺 id 的条目直接跳过）', () => {
  const ledger = new Map()
  const out = diffStatuses(ledger, [{ title: 'x', status: 'ERROR' }, task('s1', 'RUNNING')], 1000)
  assert.deepEqual(out, [])
  assert.equal(ledger.size, 1)
})

console.log('\n状态变迁提示：胶囊态判定')

check('胶囊态放行、展开态丢弃', () => {
  const transitions = [{ sessionId: 's1', title: 't', from: 'RUNNING', to: 'SUCCESS', at: 1 }]
  assert.equal(admitTransitions(transitions, true).length, 1)
  assert.deepEqual(admitTransitions(transitions, false), [])
})

check('展开态是「丢弃」而不是「排队延后」（收起时不会补报一批旧变迁）', () => {
  const transitions = [{ sessionId: 's1', title: 't', from: 'RUNNING', to: 'ERROR', at: 1 }]
  // 面板展开期间产生 → 丢弃。
  const whileExpanded = admitTransitions(transitions, false)
  // 收起时：拿到的仍是「当前这一拍」的结果，之前被丢弃的不会累积。
  assert.deepEqual(whileExpanded, [])
  const afterCollapse = admitTransitions(
    [{ sessionId: 's2', title: 'u', from: 'RUNNING', to: 'SUCCESS', at: 2 }],
    true
  )
  assert.deepEqual(afterCollapse.map((item) => item.sessionId), ['s2'])
})

check('账本与胶囊态无关：展开期间的变迁照样记账，不会被重复上报', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 0)
  const during = diffStatuses(ledger, [task('s1', 'ERROR')], 1000)
  // 展开态丢弃了这次提示……
  assert.deepEqual(admitTransitions(during, false), [])
  // ……但账本已更新：下一拍不会再报同一次 ERROR（这是「丢弃≠延后」的机制保证）。
  assert.equal(ledger.get('s1'), 'ERROR')
  assert.deepEqual(diffStatuses(ledger, [task('s1', 'ERROR')], 2000), [])
})

console.log('\n状态变迁提示：队列与 5 秒生命周期')

check('入队后按时间戳在 5 秒整点消失（不是「差不多 5 秒」）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 0)
  const transitions = diffStatuses(ledger, [task('s1', 'SUCCESS')], 1000)
  let queue = mergeToasts([], transitions)
  assert.equal(queue.length, 1)

  // 4999ms：还在。
  queue = pruneToasts(queue, 1000 + TOAST_TTL_MS - 1)
  assert.equal(queue.length, 1)
  // 5000ms：正好到期，消失。
  queue = pruneToasts(queue, 1000 + TOAST_TTL_MS)
  assert.equal(queue.length, 0)
})

check('每条提示各自计时（后到的不会被先到的提前带走）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING'), task('s2', 'RUNNING')], 0)
  const first = mergeToasts([], diffStatuses(ledger, [task('s1', 'SUCCESS'), task('s2', 'RUNNING')], 1000))
  const both = mergeToasts(first, diffStatuses(ledger, [task('s1', 'SUCCESS'), task('s2', 'ERROR')], 3000))
  assert.equal(both.length, 2)

  // 在 t=6000：s1（1000 起）已过期，s2（3000 起）还在。
  const alive = pruneToasts(both, 6000)
  assert.equal(alive.length, 1)
  assert.equal(alive[0].sessionId, 's2')
})

check('5 秒时长是一个常量，UI 与测试读同一个值', () => {
  assert.equal(TOAST_TTL_MS, 5000)
})

check('同一会话的同一目标状态替换而非堆叠（来回摆动不刷屏）', () => {
  const ledger = new Map()
  diffStatuses(ledger, [task('s1', 'RUNNING')], 0)
  const first = mergeToasts([], diffStatuses(ledger, [task('s1', 'WAIT_CONFIRM')], 1000))
  // 回答后回到运行，再次进入待确认：应替换旧的那条并续期。
  diffStatuses(ledger, [task('s1', 'RUNNING')], 2000)
  const second = mergeToasts(first, diffStatuses(ledger, [task('s1', 'WAIT_CONFIRM')], 3000))
  assert.equal(second.length, 1)
  assert.equal(second[0].at, 3000)
  // 续期后按新时间戳存活：t=7000 仍在（旧的那条 6000 就该没了）。
  assert.equal(pruneToasts(second, 7000).length, 1)
})

check('队列有上限，批量涌入时只留最新几条', () => {
  const ledger = new Map()
  const ids = ['a', 'b', 'c', 'd', 'e']
  diffStatuses(ledger, ids.map((id) => task(id, 'RUNNING')), 0)
  const transitions = diffStatuses(ledger, ids.map((id) => task(id, 'SUCCESS')), 1000)
  const queue = mergeToasts([], transitions)
  assert.equal(queue.length, TOAST_LIMIT)
  // 保留的是最后 N 条（先进先出）。
  assert.deepEqual(queue.map((item) => item.sessionId), ['c', 'd', 'e'])
})

check('没有新变迁时返回原数组引用（避免无意义的重渲染）', () => {
  const current = [{ id: 'x', sessionId: 's1', title: 't', from: 'RUNNING', to: 'SUCCESS', at: 1 }]
  assert.equal(mergeToasts(current, []), current)
})

check('文案为人话：由「进行中」变为「待确认」', () => {
  assert.equal(transitionText('RUNNING', 'WAIT_CONFIRM'), '由「进行中」变为「待确认」')
  assert.equal(transitionText('RUNNING', 'SUCCESS'), '由「进行中」变为「已达成」')
})

console.log('\n状态变迁提示：贴上方还是下方')

check('胶囊在右上角（默认位置）→ 下方', () => {
  const out = placeToast({ capsule: CAPSULE, overlay: OVERLAY })
  assert.equal(out.side, 'below')
})

check('胶囊贴近窗口底部 → 翻到上方', () => {
  const bottom = { ...CAPSULE, top: OVERLAY.top + OVERLAY.height - CAPSULE.height - 4 }
  const out = placeToast({ capsule: bottom, overlay: OVERLAY })
  assert.equal(out.side, 'above')
})

check('两侧都放不下时选宽松的一侧（宁可溢出也要选对方向）', () => {
  // 极矮窗口：上下都只有 30px（< TOAST_MIN_ROOM 72）。
  const tiny = { left: 0, top: 0, width: 400, height: 30 }
  const out = placeToast({ capsule: { left: 100, top: 40, width: 120, height: 32 }, overlay: tiny })
  // 上方 40-8-12=20，下方 30-12-(40+32+8)=-62 ⇒ 上方更宽松。
  assert.equal(out.side, 'above')
})

check('水平默认与胶囊右对齐', () => {
  const out = placeToast({ capsule: CAPSULE, overlay: OVERLAY })
  // 胶囊右缘 = 1060+120 = 1180；提示宽 264 ⇒ 左缘 916，相对胶囊左缘 = -144。
  assert.equal(out.left, 120 - TOAST_WIDTH)
})

check('胶囊贴左边时提示整体平移回窗口内（不越出左边界）', () => {
  const left = { ...CAPSULE, left: 0 }
  const out = placeToast({ capsule: left, overlay: OVERLAY })
  // 期望左缘 = overlay.left + TOAST_MARGIN = 12 ⇒ 相对胶囊 = 12。
  assert.equal(out.left, 12)
  assert.ok(out.left >= 0, '提示不应越出左边界')
})

check('窄窗口（仍能容纳提示）下不越出右边界', () => {
  // 窗口 320px 宽 > 提示 264px + 两侧留白 24px ⇒ 放得下，必须完全在内。
  const narrow = { left: 0, top: 0, width: 320, height: 600 }
  const out = placeToast({ capsule: { left: 0, top: 100, width: 120, height: 32 }, overlay: narrow })
  const leftEdge = out.left // 相对胶囊（胶囊 left = 0，故等于绝对坐标）
  assert.ok(leftEdge >= 12, '提示左缘不应越出左留白')
  assert.ok(leftEdge + TOAST_WIDTH <= narrow.width - 12, '提示右缘不应越出右留白')
})

check('窗口比提示本身还窄时退化为左对齐（此时无论如何都会溢出，不假装放得下）', () => {
  const tiny = { left: 0, top: 0, width: 200, height: 600 }
  const out = placeToast({ capsule: { left: 0, top: 100, width: 120, height: 32 }, overlay: tiny })
  // maxLeft(12+200-12-264-0 = -64) <= minLeft(12) ⇒ 取 minLeft。
  assert.equal(out.left, 12)
})

check('异常输入不产生 NaN（NaN 会让内联样式整条被丢弃）', () => {
  const out = placeToast({
    capsule: { left: NaN, top: NaN, width: NaN, height: NaN },
    overlay: { left: NaN, top: NaN, width: NaN, height: NaN }
  })
  assert.ok(Number.isFinite(out.left), 'left 必须是有限数')
  assert.ok(out.side === 'above' || out.side === 'below')
})

check('几何常量与 CSS 对齐（改一处必须改另一处）', () => {
  assert.equal(TOAST_WIDTH, 264)
  assert.equal(TOAST_GAP, 8)
  assert.ok(TOAST_MIN_ROOM >= 56, 'TOAST_MIN_ROOM 应不小于一条提示的实际高度')
})

console.log(`\n全部 ${passed} 项通过。`)
