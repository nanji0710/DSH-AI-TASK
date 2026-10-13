/**
 * 浏览器半边合并口径自检。
 *
 * 用户报告的两个缺陷都在这里：
 *   1.「大量会话显示为『待开始』，但该状态并不存在，且这些会话已很久没有新操作，
 *      按预期应归入『完成』」；
 *   2.「所有工作区都只有 15 个对话框，任务却显示 20 个」+「『未归类会话』中大部分
 *      对话明明已有各自的工作区」。
 *
 * 根因都在 `buildViewModel` 的「第二路：标准 props 补齐」：
 *   - 状态判定最后一支回落到 START ⇒ 历史会话全变「待开始」；
 *   - 从不读 `archivedSessionIds` ⇒ 归档会话被算成活跃任务（20 vs 15 的差额）；
 *   - `synthesizeTask` 把 `workspaceId` 硬编码为 null ⇒ 全部掉进「未归类会话」。
 *
 * 这些是**纯合并逻辑**，能在 Node 里直接穷举，不必等 GUI 重启才验证。
 *
 * 运行：npm run test:store
 */

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

const outdir = join(process.cwd(), 'node_modules', '.taskpulse-store-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: ['src/store/client-store.ts'],
  bundle: true,
  outdir,
  outExtension: { '.js': '.cjs' },
  platform: 'node',
  format: 'cjs',
  target: ['node20'],
  external: ['react', 'react/jsx-runtime', 'react-dom'],
  logLevel: 'warning'
})

const { buildViewModel } = require(join(outdir, 'client-store.cjs'))

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

const HOUR = 60 * 60 * 1000
const now = Date.now()

/** 一条会话行（`useSessions` 的 byId 值）。 */
function row(id, overrides = {}) {
  return { id, displayTitle: `会话 ${id}`, updatedAt: now - 30 * HOUR, ...overrides }
}

/** 一个工作区视图（`useWorkspaces` 的 items 元素）。 */
function workspace(workspaceId, sessionIds, overrides = {}) {
  return {
    workspaceId,
    path: `D:\\repos\\${workspaceId}`,
    title: workspaceId,
    sessionIds,
    updatedAt: new Date(now - HOUR).toISOString(),
    ...overrides
  }
}

/** 不传宿主快照、不传运行态：纯粹的「本地兜底路径」。 */
function view(input) {
  return buildViewModel({
    snapshot: null,
    sessions: [],
    statuses: undefined,
    workspaces: [],
    history: [],
    ...input
  })
}

console.log('浏览器半边合并口径自检')

// ---------------------------------------------------------------- 状态口径

check('闲置的历史会话收敛为「完成」，不再合成「待开始」', () => {
  const result = view({ sessions: [row('s-a')] })
  assert.equal(result.tasks.length, 1)
  assert.equal(result.tasks[0].status, 'SUCCESS')
  assert.equal(result.stats.running, 0, '不应有任务落进「运行中」计数')
  assert.equal(result.stats.success, 1)
})

check('「待开始」不会从合成路径产生（六个状态里它只属于宿主新建任务）', () => {
  // 一次覆盖全部「没有活动信号」的组合。
  const result = view({
    sessions: [
      row('s-none'),
      row('s-blankish', { running: false }),
      row('s-unread', { running: false })
    ],
    statuses: new Map([
      ['s-none', {}],
      ['s-blankish', { running: false }],
      ['s-unread', { running: false, completionUnread: false }]
    ])
  })
  assert.equal(result.tasks.filter((task) => task.status === 'START').length, 0)
  assert.equal(result.tasks.every((task) => task.status === 'SUCCESS'), true)
})

check('正在跑的会话仍是「进行中」；等确认的仍是「待确认」', () => {
  const result = view({
    sessions: [row('s-run'), row('s-pend')],
    statuses: new Map([
      ['s-run', { running: true }],
      ['s-pend', { pendingInteraction: { id: 'c-1' } }]
    ])
  })
  const byId = new Map(result.tasks.map((task) => [task.sessionId, task]))
  assert.equal(byId.get('s-run').status, 'RUNNING')
  assert.equal(byId.get('s-pend').status, 'WAIT_CONFIRM')
})

check('空会话与子代理会话依旧不占任务列表', () => {
  const result = view({
    sessions: [
      row('s-blank', { blank: true }),
      row('s-sub', { origin: 'subagent' }),
      row('s-real')
    ]
  })
  assert.deepEqual(result.tasks.map((task) => task.sessionId), ['s-real'])
})

check('子代理过滤同样作用于宿主快照（三任务僵尸卡的来源）', () => {
  // 昨天的现场：主会话派生的子代理会话在插件重启时被宿主半边建档（START），
  // 快照带着它们；useSessions 里 origin=subagent。两条路都必须拦住。
  const result = view({
    snapshot: {
      ok: true,
      stats: { running: 2, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 2 },
      workspaces: [],
      details: {
        's-sub-zombie': { sessionId: 's-sub-zombie', status: 'START', lastActionTime: now - HOUR },
        's-main': { sessionId: 's-main', status: 'RUNNING' }
      },
      conversations: [],
      pending: []
    },
    sessions: [
      row('s-sub-zombie', { origin: 'subagent' }),
      row('s-main')
    ],
    statuses: new Map([['s-main', { running: true }]])
  })
  assert.deepEqual(result.tasks.map((task) => task.sessionId), ['s-main'], '子代理卡不得单列')
  assert.equal(result.stats.total, 1, '统计与列表同口径')
  assert.equal(result.stats.running, 1)
})

// ---------------------------------------------------------------- 归档口径

check('归档会话不算活跃任务（侧栏 15 与任务 20 的差额来源）', () => {
  const sessions = [row('s-1'), row('s-2'), row('s-3')]
  const withoutFilter = view({ sessions })
  assert.equal(withoutFilter.tasks.length, 3)

  const filtered = view({ sessions, archivedSessionIds: ['s-2'] })
  assert.deepEqual(filtered.tasks.map((task) => task.sessionId).sort(), ['s-1', 's-3'])
  assert.equal(filtered.stats.total, 2, '统计也必须同步扣除，否则数字与列表打架')
})

check('归档过滤同样作用于宿主快照里的任务（两条路一致）', () => {
  const result = view({
    snapshot: {
      ok: true,
      stats: { running: 2, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 2 },
      workspaces: [],
      details: {
        's-live': { sessionId: 's-live', status: 'RUNNING' },
        's-archived': { sessionId: 's-archived', status: 'SUCCESS' }
      },
      conversations: [],
      pending: []
    },
    archivedSessionIds: ['s-archived']
  })
  assert.deepEqual(result.tasks.map((task) => task.sessionId), ['s-live'])
})

check('快照里的「待开始」按权威运行态收敛：在跑→进行中，不在跑→完成', () => {
  const snapshot = {
    ok: true,
    stats: { running: 2, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 2 },
    workspaces: [],
    details: {
      // 宿主僵尸记录：建档后从未收到状态迁移事件，停在 START。
      's-zombie-idle': { sessionId: 's-zombie-idle', status: 'START', lastActionTime: now - HOUR },
      's-zombie-live': { sessionId: 's-zombie-live', status: 'START', lastActionTime: now - HOUR }
    },
    conversations: [],
    pending: []
  }
  const result = view({
    snapshot,
    sessions: [row('s-zombie-idle'), row('s-zombie-live')],
    statuses: new Map([
      ['s-zombie-idle', { running: false }],
      ['s-zombie-live', { running: true }]
    ])
  })
  const byId = new Map(result.tasks.map((task) => [task.sessionId, task]))
  assert.equal(byId.get('s-zombie-idle').status, 'SUCCESS', '不在跑的 START 不得直通 UI')
  assert.equal(byId.get('s-zombie-live').status, 'RUNNING', '确实在跑的 START 应显示进行中')
  assert.equal(result.stats.running, 1, '运行计数只算真正在跑的')
  assert.equal(result.stats.success, 1)
})

// ---------------------------------------------------------------- 归属口径

check('合成任务当场写入工作区归属（不再一律 null）', () => {
  const result = view({
    sessions: [row('s-a'), row('s-b')],
    workspaces: [workspace('ws-1', ['s-a']), workspace('ws-2', ['s-b'])]
  })
  const byId = new Map(result.tasks.map((task) => [task.sessionId, task]))
  assert.equal(byId.get('s-a').workspaceId, 'ws-1')
  assert.equal(byId.get('s-b').workspaceId, 'ws-2')
})

check('有工作区的会话不再掉进「未归类会话」', () => {
  const result = view({
    sessions: [row('s-a'), row('s-b')],
    workspaces: [workspace('ws-1', ['s-a']), workspace('ws-2', ['s-b'])]
  })
  assert.equal(result.workspaces.some((group) => group.id === '__default__'), false)
  assert.deepEqual(result.workspaces.map((group) => group.id).sort(), ['ws-1', 'ws-2'])
})

check('确实无归属的会话才进「未归类会话」，并如实计数', () => {
  const result = view({
    sessions: [row('s-a'), row('s-orphan')],
    workspaces: [workspace('ws-1', ['s-a'])]
  })
  const orphan = result.workspaces.find((group) => group.id === '__default__')
  assert.ok(orphan, '无归属会话应有兜底分组')
  assert.equal(orphan.name, '未归类会话')
  assert.equal(orphan.conversationCount, 1)
  assert.equal(orphan.counts.total, 1)
})

check('归属在会话属于多个工作区时取先声明者（稳定，不抖动）', () => {
  const result = view({
    sessions: [row('s-a')],
    workspaces: [workspace('ws-1', ['s-a']), workspace('ws-2', ['s-a'])]
  })
  assert.equal(result.tasks[0].workspaceId, 'ws-1')
})

// ------------------------------------------------- 提问通道（方案 c：客户端补规则）

/** 一条宿主已建档的任务（走第一路快照，第二路只做校正）。 */
function hostSnapshot(overrides = {}) {
  return {
    ok: true,
    stats: { running: 0, waitConfirm: 1, success: 0, error: 0, blocked: 0, total: 1 },
    workspaces: [],
    details: {
      's-ask': {
        sessionId: 's-ask',
        id: 's-ask',
        title: '问了一句',
        status: 'WAIT_CONFIRM',
        workspaceId: null,
        runStartedAt: now - 60000,
        ...overrides
      }
    },
    conversations: [],
    pending: []
  }
}

check('宿主已建档的任务也会被 pendingInteraction 提升为「待确认」', () => {
  // 宿主的提问通道靠 tool/call 特判，客户端多一层零延迟兜底。
  const result = view({
    snapshot: hostSnapshot({ status: 'RUNNING' }),
    sessions: [row('s-ask')],
    statuses: new Map([['s-ask', { running: true, pendingInteraction: { kind: 'question', callId: 'c-1' } }]])
  })
  assert.equal(result.tasks[0].status, 'WAIT_CONFIRM')
})

check('pendingInteraction 消失后回落为「进行中」，不会永久卡在待确认', () => {
  const result = view({
    snapshot: hostSnapshot({ status: 'WAIT_CONFIRM' }),
    sessions: [row('s-ask')],
    statuses: new Map([['s-ask', { running: true }]])
  })
  assert.equal(result.tasks[0].status, 'RUNNING')
})

check('已完成的会话挂着一张「回看用」的只读提问卡，不会被翻回待确认', () => {
  // `PendingQuestion.review` 有值 = 这次提问早已结束，只是用户点开重看。
  const result = view({
    snapshot: hostSnapshot({ status: 'SUCCESS' }),
    sessions: [row('s-ask')],
    statuses: new Map([['s-ask', { running: false, pendingInteraction: { kind: 'question', review: {} } }]])
  })
  assert.equal(result.tasks[0].status, 'SUCCESS')
})

check('合成路径同样不把只读回看卡当成「等你处理」', () => {
  const result = view({
    sessions: [row('s-review')],
    statuses: new Map([['s-review', { running: false, pendingInteraction: { kind: 'question', review: {} } }]])
  })
  assert.equal(result.tasks[0].status, 'SUCCESS')
})

check('pendingInteraction 生效时不再依赖宿主快照（宿主离线也准）', () => {
  const result = view({
    snapshot: null,
    sessions: [row('s-live')],
    statuses: new Map([['s-live', { running: true, pendingInteraction: { kind: 'approval' } }]])
  })
  assert.equal(result.tasks[0].status, 'WAIT_CONFIRM')
})

// ---------------------------------------------------------------- 会话数口径

check('conversationCount 是工作区可见会话数，不是「插件已建档任务数」', () => {
  const result = view({
    // 工作区里有 4 条会话，但只有 1 条产生过任务记录 —— 两个数字必须分开。
    sessions: [row('s-a')],
    workspaces: [workspace('ws-1', ['s-a', 's-b', 's-c', 's-d'])]
  })
  const group = result.workspaces.find((item) => item.id === 'ws-1')
  assert.equal(group.conversationCount, 4, '应取工作区真实会话数')
  assert.equal(group.counts.total, 1, '状态计数仍只数活跃任务')
})

check('conversationCount 同样扣除归档会话（与侧栏口径对齐）', () => {
  const result = view({
    sessions: [],
    workspaces: [workspace('ws-1', ['s-a', 's-b', 's-c'])],
    archivedSessionIds: ['s-b']
  })
  const group = result.workspaces.find((item) => item.id === 'ws-1')
  assert.equal(group.conversationCount, 2)
})

check('空工作区仍出现在列表里（规范 5 要求先铺全部工作区）', () => {
  const result = view({ workspaces: [workspace('ws-empty', [])] })
  assert.equal(result.workspaces.length, 1)
  assert.equal(result.workspaces[0].conversationCount, 0)
  assert.equal(result.workspaces[0].counts.total, 0)
})

console.log(`\n全部 ${passed} 项通过。`)
