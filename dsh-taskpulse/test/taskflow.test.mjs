/**
 * 宿主半边状态流转自检（方案 a：提问通道）。
 *
 * 用户报告：「有一个步骤是向用户提问，这个不是要我确认吗？为什么现在还显示运行，
 * 而不是待确认？」根因是插件只订阅了 DSH 两条「等人」通道里的一条：
 *   - 审批通道 `approval/asked` / `approval/decided` —— 原先唯一能进 WAIT_CONFIRM 的路径；
 *   - 提问通道 `ask_user_question` / `exit_plan_mode` —— 宿主**不追加任何事件**，
 *     会话流里只有一条普通 `tool/call`，于是卡片一直停在「运行中」。
 *
 * 这里直接驱动 `TaskStore.applyEvent`，把这条链路逐事件走一遍 —— 它是纯归约，
 * 不必等 GUI 就能验证。断言的是**状态与挂起项**，不是内部字段。
 *
 * 运行：npm run test:taskflow
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

// 必须落在项目 node_modules 下：`os.tmpdir()` 里的产物向上解析不到本项目的依赖。
const outdir = join(process.cwd(), 'node_modules', '.taskpulse-taskflow-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['src/store/task-store.ts'],
  bundle: true,
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  logLevel: 'warning'
})

const { TaskStore } = require(join(outdir, 'task-store.cjs'))

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

const SESSION = 'session-ask'
let clock = 1_000_000

/** 新建一个干净的 store，时钟可控。 */
function makeStore() {
  clock = 1_000_000
  const store = new TaskStore()
  store.setClock(() => clock)
  store.setWorkspaceResolver(() => null)
  return store
}

/** 送一条事件；`data` 即 `session.append(type, data)` 的载荷。 */
function emit(store, type, data, seq) {
  clock += 1000
  store.applyEvent(SESSION, { type, seq, time: clock, data })
  return store.get(SESSION)
}

const task = (store) => store.get(SESSION)

console.log('宿主半边状态流转自检（提问通道）')

// ---------------------------------------------------------------- 提问通道

check('ask_user_question 的 tool/call 立刻进入「待确认」', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  assert.equal(task(store).status, 'RUNNING', '起手应是运行中')

  const after = emit(store, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-1',
    name: 'ask_user_question',
    arguments: { questions: [{ id: 'q1', question: '用哪种方案？' }] }
  })
  assert.equal(after.status, 'WAIT_CONFIRM', '提问后整轮停住，就是「待确认」')
  assert.ok(after.pendingConfirm, '应有挂起的确认项')
  assert.equal(after.pendingConfirm.kind, 'question', '走的是提问通道')
  assert.equal(after.pendingConfirm.callId, 'call-1', 'callId 用于与答复配对')
  assert.equal(after.pendingConfirm.reason, '用哪种方案？', '提问原文应作为「提问内容」展示')
  assert.match(after.currentStep, /等待确认/, '当前步骤应说明在等人')
})

check('exit_plan_mode 同样进入「待确认」（同一条通道）', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  const after = emit(store, 'tool/call', {
    turn: 1,
    step: 1,
    callId: 'call-plan',
    name: 'exit_plan_mode',
    arguments: { plan: '# 计划\n先做 A，再做 B。' }
  })
  assert.equal(after.status, 'WAIT_CONFIRM')
  assert.equal(after.pendingConfirm.kind, 'question')
})

check('普通工具调用不会误判为「待确认」', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  const after = emit(store, 'tool/call', { turn: 1, step: 1, callId: 'call-r', name: 'read', arguments: { file_path: 'a.ts' } })
  assert.equal(after.status, 'RUNNING')
  assert.equal(after.pendingConfirm, null)
  assert.equal(after.currentStep, '读取文件')
})

check('答复到达（同 callId 的 tool/result）后回到「进行中」并清除挂起项', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', {
    turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: { questions: [{ question: '用哪种方案？' }] }
  })
  const after = emit(store, 'tool/result', {
    turn: 1,
    step: 1,
    message: { isError: false, toolCallId: 'call-1', content: '{"answers":[]}' }
  })
  assert.equal(after.status, 'RUNNING', '答完就继续跑')
  assert.equal(after.pendingConfirm, null, '挂起项必须清除，否则永远显示待确认')
})

check('别的问题的 tool/result 不会误清当前挂起项', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', {
    turn: 1, step: 1, callId: 'call-1', name: 'ask_user_question', arguments: { questions: [{ question: 'A 还是 B？' }] }
  })
  const after = emit(store, 'tool/result', {
    turn: 1, step: 1, message: { isError: false, toolCallId: 'call-other', content: 'ok' }
  })
  assert.equal(after.status, 'WAIT_CONFIRM', '答的不是这个问题，仍应在等用户')
  assert.ok(after.pendingConfirm)
})

check('user-question-reply 消息也能解除挂起（宿主的答复记录路径）', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', {
    turn: 1, step: 1, callId: 'call-2', name: 'ask_user_question', arguments: { questions: [{ question: '选一个' }] }
  })
  const after = emit(store, 'user/message', {
    source: { kind: 'user-question-reply', callId: 'call-2', outcome: 'answered' },
    content: '选 A'
  })
  assert.equal(after.status, 'RUNNING')
  assert.equal(after.pendingConfirm, null)
})

check('提问被答复的 user/message 不会被误当成新的一轮起点', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  const afterTurn = task(store).runStartedAt
  emit(store, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'ask_user_question', arguments: { questions: [{ question: '?' }] } })
  emit(store, 'user/message', { source: { kind: 'user-question-reply', callId: 'c' }, content: 'A' })
  assert.equal(task(store).runStartedAt, afterTurn, '答复不是用户新需求，本轮起点不该被改写')
})

check('真人的 user/message 仍会开启新的一轮（回归保护）', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'turn/end', { turn: 1, reason: 'completed' })
  assert.equal(task(store).status, 'SUCCESS')
  const after = emit(store, 'user/message', { source: { kind: 'user', messageSeqs: [] }, content: '接着做' })
  assert.equal(after.status, 'RUNNING', '新需求应复活为进行中')
  assert.equal(after.finishedAt, null)
})

// ---------------------------------------------------------------- 审批通道

check('approval/asked 仍是「待确认」，且标记为审批通道', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  const after = emit(store, 'approval/asked', {
    id: 'appr-1', toolName: 'edit', callId: 'call-9', reason: '将写入 3 个文件'
  })
  assert.equal(after.status, 'WAIT_CONFIRM')
  assert.equal(after.pendingConfirm.kind, 'approval')
  assert.equal(after.pendingConfirm.reason, '将写入 3 个文件')
})

check('approval/decided 的三种官结果：放行→进行中，拒绝/中止→阻塞', () => {
  const denied = makeStore()
  emit(denied, 'turn/start', { turn: 1 })
  emit(denied, 'approval/asked', { id: 'a1', toolName: 'edit', callId: 'c1' })
  const blocked = emit(denied, 'approval/decided', { id: 'a1', outcome: 'rejected' })
  assert.equal(blocked.status, 'BLOCKED')
  assert.equal(blocked.pendingConfirm, null)

  const cancelled = makeStore()
  emit(cancelled, 'turn/start', { turn: 1 })
  emit(cancelled, 'approval/asked', { id: 'a3', toolName: 'edit', callId: 'c3' })
  // 中止同样没放行：显示「进行中」会让用户以为工具跑过了。
  assert.equal(emit(cancelled, 'approval/decided', { id: 'a3', outcome: 'cancelled' }).status, 'BLOCKED')

  const allowed = makeStore()
  emit(allowed, 'turn/start', { turn: 1 })
  emit(allowed, 'approval/asked', { id: 'a2', toolName: 'edit', callId: 'c2' })
  const running = emit(allowed, 'approval/decided', { id: 'a2', outcome: 'allowed-once' })
  assert.equal(running.status, 'RUNNING')
})

// ---------------------------------------------------------------- 权威信号

check('运行信号不会把「待确认」冲成「进行中」（两条通道都算）', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'ask_user_question', arguments: { questions: [{ question: '?' }] } })
  store.applyRunning(SESSION, true)
  assert.equal(task(store).status, 'WAIT_CONFIRM', '等人时仍然在跑，但不是「进行中」')
})

check('turn/end 收尾会清掉残留的挂起项', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'ask_user_question', arguments: { questions: [{ question: '?' }] } })
  const after = emit(store, 'turn/end', { turn: 1, reason: 'completed' })
  assert.equal(after.status, 'SUCCESS')
  assert.equal(after.pendingConfirm, null)
})

check('pendingConfirms() 能把提问通道的挂起项报给浏览器半边', () => {
  const store = makeStore()
  emit(store, 'turn/start', { turn: 1 })
  emit(store, 'tool/call', { turn: 1, step: 1, callId: 'c', name: 'ask_user_question', arguments: { questions: [{ question: '选哪个？' }] } })
  const pending = store.pendingConfirms()
  assert.equal(pending.length, 1)
  assert.equal(pending[0].sessionId, SESSION)
  assert.equal(pending[0].kind, 'question')
})

console.log(`\n全部 ${passed} 项通过。`)
