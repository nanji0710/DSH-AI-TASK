/**
 * 模型层自检：状态机、计数、自动隐藏、格式化、工具标签。
 *
 * 这些规则同时被宿主半边与浏览器半边使用（src/models 是共享纯净层），
 * 因此必须被独立验证。本测试不引入任何测试框架：先用 esbuild 把 models
 * 层打成临时 ESM 文件，再用 node:assert 断言。
 *
 * 运行：npm test
 */

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build } from 'esbuild'

// ---- 1. 打包被测模块（models 层是纯净 TS，无浏览器 / Node 依赖） ----
const outdir = mkdtempSync(join(tmpdir(), 'taskpulse-test-'))
const outfile = join(outdir, 'models.mjs')

await build({
  entryPoints: ['src/models/index.ts'],
  bundle: true,
  outfile,
  platform: 'neutral',
  format: 'esm',
  target: ['node20'],
  logLevel: 'warning'
})

const models = await import(pathToFileURL(outfile).href)
rmSync(outdir, { recursive: true, force: true })

const {
  TASK_STATUS,
  STATUS_TONE,
  STATUS_LABEL,
  addToCounts,
  emptyCounts,
  canTransition,
  deriveProgress,
  formatDuration,
  formatRelativeTime,
  isTerminal,
  shouldArchiveInactive,
  runDuration,
  taskStepText,
  summarizeToolArguments,
  toolLabel
} = models

let passed = 0

/** 执行一项断言，失败即抛（进程非 0 退出）。 */
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

console.log('models 层自检')

// ---- 状态机（规范 4） ----
check('状态机：START 可进入全部执行态', () => {
  assert.equal(canTransition(TASK_STATUS.START, TASK_STATUS.RUNNING), true)
  assert.equal(canTransition(TASK_STATUS.START, TASK_STATUS.WAIT_CONFIRM), true)
  assert.equal(canTransition(TASK_STATUS.START, TASK_STATUS.SUCCESS), true)
})

check('状态机：RUNNING 可转四种后继状态', () => {
  for (const target of ['SUCCESS', 'ERROR', 'WAIT_CONFIRM', 'BLOCKED']) {
    assert.equal(canTransition(TASK_STATUS.RUNNING, TASK_STATUS[target]), true, `RUNNING -> ${target}`)
  }
})

check('状态机：WAIT_CONFIRM 可回到 RUNNING（用户确认后继续）', () => {
  assert.equal(canTransition(TASK_STATUS.WAIT_CONFIRM, TASK_STATUS.RUNNING), true)
})

check('终态判定', () => {
  assert.equal(isTerminal(TASK_STATUS.SUCCESS), true)
  assert.equal(isTerminal(TASK_STATUS.ERROR), true)
  assert.equal(isTerminal(TASK_STATUS.BLOCKED), true)
  assert.equal(isTerminal(TASK_STATUS.RUNNING), false)
  assert.equal(isTerminal(TASK_STATUS.WAIT_CONFIRM), false)
})

// ---- 归档规则（用户要求：超过一天无操作归入 History） ----
check('归档：超过 24 小时无操作即移入 History', () => {
  const DAY = 24 * 60 * 60 * 1000
  const base = { lastActionTime: 0 }
  assert.equal(shouldArchiveInactive(base, DAY - 1000), false, '差一秒不到一天不应归档')
  assert.equal(shouldArchiveInactive(base, DAY), true, '满一天应归档')
  assert.equal(shouldArchiveInactive(base, 3 * DAY), true, '超过一天应归档')
})

check('归档不挑状态：长期无事件的 RUNNING 同样归档（它事实上已死）', () => {
  const DAY = 24 * 60 * 60 * 1000
  const stale = { status: TASK_STATUS.RUNNING, lastActionTime: 0 }
  assert.equal(shouldArchiveInactive(stale, 2 * DAY), true, '挂了 48 小时的「运行中」必须收敛')
})

check('归档：一天以内的异常与阻塞仍留在活跃列表（快速发现异常）', () => {
  const HOUR = 3600 * 1000
  assert.equal(shouldArchiveInactive({ status: TASK_STATUS.ERROR, lastActionTime: 0 }, 10 * HOUR), false)
  assert.equal(shouldArchiveInactive({ status: TASK_STATUS.BLOCKED, lastActionTime: 0 }, 10 * HOUR), false)
})

// ---- 状态色 / 标签（规范 7） ----
check('状态色与标签覆盖全部状态，且取值符合规范 7', () => {
  for (const status of Object.values(TASK_STATUS)) {
    assert.ok(STATUS_TONE[status], `${status} 缺少色调`)
    assert.ok(STATUS_LABEL[status], `${status} 缺少标签`)
  }
  assert.equal(STATUS_TONE.RUNNING, 'blue')
  assert.equal(STATUS_TONE.WAIT_CONFIRM, 'yellow')
  assert.equal(STATUS_TONE.SUCCESS, 'green')
  assert.equal(STATUS_TONE.ERROR, 'red')
  assert.equal(STATUS_TONE.BLOCKED, 'orange')
})

// ---- 计数 ----
check('状态计数累加（工作区分组统计的数据来源）', () => {
  let counts = emptyCounts()
  counts = addToCounts(counts, TASK_STATUS.RUNNING)
  counts = addToCounts(counts, TASK_STATUS.RUNNING)
  counts = addToCounts(counts, TASK_STATUS.WAIT_CONFIRM)
  counts = addToCounts(counts, TASK_STATUS.ERROR)
  assert.deepEqual(counts, { running: 2, waitConfirm: 1, success: 0, error: 1, blocked: 0, total: 4 })
})

check('计数：START 计入运行中（尚未开始也算活跃）', () => {
  const counts = addToCounts(emptyCounts(), TASK_STATUS.START)
  assert.equal(counts.running, 1)
  assert.equal(counts.total, 1)
})

// ---- 进度 ----
check('进度推导：终态 0 / 1，运行中单调递增且有上限', () => {
  assert.equal(deriveProgress(TASK_STATUS.SUCCESS, 5), 1)
  assert.equal(deriveProgress(TASK_STATUS.START, 0), 0)
  const low = deriveProgress(TASK_STATUS.RUNNING, 1)
  const high = deriveProgress(TASK_STATUS.RUNNING, 40)
  assert.ok(high > low, '步数增多进度应上升')
  assert.ok(high <= 0.95, `进度不得超过 0.95，实际 ${high}`)
})

// ---- 格式化 ----
check('耗时格式化（对齐原型 00:12:36）', () => {
  assert.equal(formatDuration(45 * 1000), '45秒')
  assert.equal(formatDuration(12 * 60 * 1000 + 36 * 1000), '12:36')
  assert.equal(formatDuration(12 * 3600 * 1000 + 36 * 60 * 1000 + 5 * 1000), '12:36:05')
  assert.equal(formatDuration(-1), '0秒', '负数需被夹到 0')
})

check('相对时间格式化（规范 5「最近动作时间」）', () => {
  const now = 1_000_000_000
  assert.equal(formatRelativeTime(now - 30 * 1000, now), '刚刚')
  assert.equal(formatRelativeTime(now - 3 * 60 * 1000, now), '3分钟前')
  assert.equal(formatRelativeTime(now - 2 * 3600 * 1000, now), '2小时前')
  assert.equal(formatRelativeTime(now - 3 * 24 * 3600 * 1000, now), '3天前')
})

check('运行耗时：按对话自己的起点计算，未知起点显示 —', () => {
  // 分钟位补零，与 `12:36` 的展示一致。
  assert.equal(runDuration({ runStartedAt: 1000, finishedAt: null }, 61_000), '01:00')
  assert.equal(
    runDuration({ runStartedAt: 1000, finishedAt: 121_000 }, 999_999),
    '02:00',
    '结束后不应继续计时'
  )
  // 回归：没有该对话自己的起点时必须留白，不得拿任何共享基准冒充。
  assert.equal(runDuration({ runStartedAt: null, finishedAt: null }, 999_999), '—')
})

check('回归：两条对话的运行耗时必须彼此独立（用户报告的缺陷）', () => {
  // 复现场景：一个仍在执行，另一个已结束五六个小时。
  // 旧实现下两条都从同一个「插件加载时刻」起算，因此显示相同的数字。
  const now = 1_000_000_000
  const running = { runStartedAt: now - 12 * 60 * 1000, finishedAt: null }
  const finished = { runStartedAt: now - 6 * 3600 * 1000, finishedAt: now - 6 * 3600 * 1000 + 90 * 1000 }
  const a = runDuration(running, now)
  const b = runDuration(finished, now)
  assert.notEqual(a, b, `两条对话耗时不应相同，实际均为 ${a}`)
  assert.equal(a, '12:00')
  assert.equal(b, '01:30')
})

check('列表步骤文案：只暴露状态与当前步骤', () => {
  assert.equal(taskStepText({ status: TASK_STATUS.RUNNING, currentStep: '执行命令' }), '执行命令')
  assert.equal(taskStepText({ status: TASK_STATUS.RUNNING, currentStep: null }), '思考中')
  assert.equal(taskStepText({ status: TASK_STATUS.WAIT_CONFIRM, currentStep: null }), '等待确认')
  // 终态没有「当前步骤」的概念，不应硬造一行。
  assert.equal(taskStepText({ status: TASK_STATUS.SUCCESS, currentStep: null }), null)
  assert.equal(taskStepText({ status: TASK_STATUS.ERROR, currentStep: null }), null)
  assert.equal(taskStepText({ status: TASK_STATUS.RUNNING, currentStep: '' }), '思考中', '空串等同缺失')
})

// ---- 工具标签（Timeline 人类可读性的关键） ----
check('工具名 → 中文动作标签', () => {
  assert.equal(toolLabel('pwsh'), '执行命令')
  assert.equal(toolLabel('read'), '读取文件')
  assert.equal(toolLabel('edit'), '修改文件')
  // 未知工具必须优雅退化，不能抛。
  assert.equal(toolLabel('some_unknown_tool_xyz'), 'some_unknown_tool_xyz')
  assert.equal(toolLabel(undefined), '执行中', '空工具名需有兜底文案')
})

check('工具参数摘要：优先挑命令 / 路径，截断且不抛异常', () => {
  assert.equal(summarizeToolArguments({ command: 'npm run build' }), 'npm run build')
  assert.ok(summarizeToolArguments({ file_path: 'D:/a/b.ts' }).startsWith('file_path: '))
  const long = summarizeToolArguments({ path: 'D:/a/'.repeat(60) })
  assert.ok(long.length <= 120, `摘要需截断，实际 ${long.length}`)
  assert.ok(!long.includes('\n'), '摘要必须是单行')
  // 循环引用不能导致崩溃。
  const cyclic = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => summarizeToolArguments(cyclic))
  assert.equal(summarizeToolArguments(null), '', '空入参返回空串')
})

console.log(`\n全部 ${passed} 项通过。`)
