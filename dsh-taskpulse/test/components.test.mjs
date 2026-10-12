/**
 * 列表展示契约自检。
 *
 * 用户明确要求：「对话任务列表只需显示该对话的当前状态和当前步骤，
 * 工具调用、子代理不需要展示。」
 *
 * 这条要求是**关于渲染结果**的，只测函数返回值覆盖不到 —— 卡片完全可能
 * 状态算对了、却仍然把 Timeline 渲染出来（这正是修复前的实际情形：
 * `showTimeline` 默认 true，而调用方从不传参）。因此这里把真实的组件层
 * 用 esbuild 打成 CJS，再用 react-dom/server 渲染成 HTML 直接断言。
 *
 * 运行：npm run test:components
 */

import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { build } from 'esbuild'

const require = createRequire(import.meta.url)

// ---- 1. 把组件层打成 CJS（react 外置，用项目自己的 react 实例渲染） ----
// ⚠️ 产物必须落在项目内：若写到 os.tmpdir()，打包结果里的 `require('react')`
//    会从临时目录向上解析、找不到项目的 node_modules 而 MODULE_NOT_FOUND。
//    放进 node_modules 下既保证解析正确，又天然被 .gitignore 覆盖。
const outdir = join(process.cwd(), 'node_modules', '.taskpulse-components-test')
mkdirSync(outdir, { recursive: true })

await build({
  entryPoints: [
    'src/components/TaskCard.tsx',
    'src/components/WorkspaceGroup.tsx',
    'src/components/TaskDetail.tsx',
    'src/components/TaskPanel.tsx'
  ],
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

const { TaskCard } = require(join(outdir, 'TaskCard.cjs'))
const { WorkspaceGroup } = require(join(outdir, 'WorkspaceGroup.cjs'))
const { TaskDetailView } = require(join(outdir, 'TaskDetail.cjs'))
const { TaskPanel, matchesFilter, TASK_FILTER_LABEL } = require(join(outdir, 'TaskPanel.cjs'))
const React = require('react')
const { renderToStaticMarkup } = require('react-dom/server')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

/** 构造一条「流水很多」的任务：多次工具调用 + 一次子代理派生。 */
function makeTask(overrides = {}) {
  const now = Date.now()
  return {
    id: 's1',
    sessionId: 's1',
    workspaceId: 'w1',
    title: '对话 A',
    status: 'RUNNING',
    progress: 0.4,
    currentStep: '修改文件',
    currentDetail: 'src/index.ts',
    agent: 'DeepSeek-Coder',
    model: 'deepseek-chat',
    startedAt: now - 8 * 3600 * 1000,
    runStartedAt: now - 12 * 60 * 1000,
    lastActionTime: now - 1000,
    finishedAt: null,
    turn: 3,
    step: 7,
    toolCalls: 42,
    steps: 9,
    error: null,
    pendingConfirm: null,
    timeline: [
      { time: now - 5000, action: '读取文件', detail: 'src/index.ts', status: 'done' },
      { time: now - 4000, action: '执行命令', detail: 'npm test', status: 'done' },
      { time: now - 3000, action: '派生子代理', detail: '调研 API 用法', status: 'done' },
      { time: now - 2000, action: '修改文件', detail: 'src/client/index.tsx', status: 'active' }
    ],
    ...overrides
  }
}

const render = (Component, props) => renderToStaticMarkup(React.createElement(Component, props))

console.log('列表展示契约自检')

// ---- 2. 列表卡片：只留状态 + 当前步骤 ----
check('TaskCard 只展示状态与当前步骤（含 Agent）', () => {
  const html = render(TaskCard, { task: makeTask() })
  assert.ok(html.includes('对话 A'), '必须展示对话标题')
  assert.ok(html.includes('进行中'), '必须展示当前状态')
  assert.ok(html.includes('修改文件'), '必须展示当前步骤')
  assert.ok(html.includes('Agent: DeepSeek-Coder'), '应展示 Agent 名')
  // 用户要求：把「当前:」改成「当前执行：」。
  assert.ok(html.includes('当前执行：'), '步骤标签必须写作「当前执行：」')
  assert.ok(!html.includes('当前:'), '旧的「当前:」写法不得残留')
})

check('TaskCard 不展示工具调用次数与子代理', () => {
  const html = render(TaskCard, { task: makeTask() })
  assert.ok(!html.includes('次工具调用'), '不得展示工具调用次数文案')
  assert.ok(!html.includes('42'), '不得展示工具调用计数')
  assert.ok(!html.includes('派生子代理'), '不得展示子代理条目')
  assert.ok(!html.includes('执行命令'), '不得展示工具调用流水')
  assert.ok(!html.includes('读取文件'), '不得展示工具调用流水')
  assert.ok(!html.includes('tp-timeline'), '不得渲染 Timeline 容器')
})

check('TaskCard 的当前步骤为空时按状态给出确定性兜底', () => {
  const running = render(TaskCard, { task: makeTask({ currentStep: null }) })
  assert.ok(running.includes('思考中'), '运行中缺步骤应显示「思考中」')
  const done = render(
    TaskCard,
    { task: makeTask({ status: 'SUCCESS', currentStep: null, finishedAt: Date.now() }) }
  )
  assert.ok(!done.includes('当前执行：'), '终态无步骤时不应渲染「当前执行：」空行')
})

check('TaskCard 保留错误行（异常状态的内容本身，不是流水）', () => {
  const html = render(TaskCard, { task: makeTask({ status: 'ERROR', error: '连接超时' }) })
  assert.ok(html.includes('连接超时'), '异常原因必须可见')
  assert.ok(!html.includes('tp-timeline'), '异常卡片同样不展示 Timeline')
})

// ---- 3. 工作区分组：复用卡片，因此同样干净 ----
check('WorkspaceGroup 渲染出的卡片同样不含工具调用与子代理', () => {
  const now = Date.now()
  const workspace = {
    id: 'w1',
    name: 'GoldPulse',
    path: 'D:/GoldPulse',
    conversationCount: 1,
    counts: { running: 1, waitConfirm: 0, success: 0, error: 0, blocked: 0, total: 1 },
    updatedAt: now
  }
  const html = render(WorkspaceGroup, { workspace, tasks: [makeTask()], now })
  assert.ok(html.includes('GoldPulse'), '应展示工作区名')
  assert.ok(html.includes('修改文件'), '应展示当前步骤')
  assert.ok(!html.includes('次工具调用'), '不得展示工具调用次数')
  assert.ok(!html.includes('派生子代理'), '不得展示子代理')
  assert.ok(!html.includes('tp-timeline'), '不得渲染 Timeline')
})

// ---- 4. 列表一律不渲染运行/耗时（用户要求删掉那一行） ----
// 用户原话：「下面哪一行的运行可以删掉，因为一直显示—」。
// 这不只是「隐藏 —」：耗时本身也要从列表消失，因为真实数据下它几乎永远无值
// （runStartedAt 只在插件亲眼看到 turn/start 时写入），恒为「—」的一行
// 不传递信息，只让人怀疑功能坏了。
check('无论是否测到运行起点，列表都不渲染运行/耗时行', () => {
  const withStart = render(TaskCard, { task: makeTask({ runStartedAt: Date.now() - 12 * 60 * 1000 }) })
  assert.ok(!withStart.includes('运行:'), `列表不应出现「运行:」，实际：${withStart.slice(0, 400)}`)
  assert.ok(!withStart.includes('耗时:'), '列表不应出现「耗时:」')
  assert.ok(!withStart.includes('12:00'), '即使有时间数据也不在列表显示')

  const withoutStart = render(TaskCard, { task: makeTask({ runStartedAt: null }) })
  assert.ok(!withoutStart.includes('运行:'), '未观测到起点时同样不出现「运行:」')
  assert.ok(!withoutStart.includes('耗时:'), '未观测到起点时同样不出现「耗时:」')
  assert.ok(!withoutStart.includes('—'), '不得渲染占位的 —')

  const done = render(TaskCard, { task: makeTask({ status: 'SUCCESS', currentStep: null, finishedAt: Date.now() }) })
  assert.ok(!done.includes('耗时:'), '成功态同样不显示耗时')
})

// ---- 5. 详情视图仍然保留完整流水（列表的克制不该牺牲可回溯性） ----
check('TaskDetailView 仍然展示完整 Timeline 与工具计数', () => {
  const html = render(TaskDetailView, { task: makeTask(), now: Date.now() })
  assert.ok(html.includes('tp-timeline'), '详情视图必须保留 Timeline')
  assert.ok(html.includes('执行命令'), '详情视图必须保留工具调用流水')
  assert.ok(html.includes('派生子代理'), '详情视图保留子代理记录，便于回溯')
})

check('TaskDetailView 的耗时同样带 null 守卫（不再出现「耗时: —」）', () => {
  const known = render(TaskDetailView, { task: makeTask({ runStartedAt: Date.now() - 12 * 60 * 1000 }), now: Date.now() })
  assert.ok(known.includes('耗时:'), '测到起点时详情页应给出耗时')
  const unknown = render(TaskDetailView, { task: makeTask({ runStartedAt: null }), now: Date.now() })
  assert.ok(!unknown.includes('耗时:'), '未测到起点时详情页不应出现「耗时:」')
  assert.ok(!unknown.includes('—'), '也不应渲染占位的 —')
  assert.ok(unknown.includes('状态:'), '状态本身仍必须展示')
})

// ---- 6. 状态筛选（用户要求：列表能按 进行中/待确认/完成/异常 切换查找） ----
console.log('状态筛选：')

check('筛选口径与统计口径一致：进行中含待开始', () => {
  // 胶囊上的数字与筛选共用 matchesFilter；两者若不一致，用户点「异常 1」会看到 0 条。
  assert.equal(matchesFilter({ status: 'START' }, 'running'), true, '待开始应算作进行中')
  assert.equal(matchesFilter({ status: 'RUNNING' }, 'running'), true)
  assert.equal(matchesFilter({ status: 'SUCCESS' }, 'running'), false)
  assert.equal(matchesFilter({ status: 'ERROR' }, 'error'), true)
  assert.equal(matchesFilter({ status: 'BLOCKED' }, 'blocked'), true)
  // 阻塞不再混进「异常」：它有自己的胶囊，混进来会让「异常 3」点开是 4 条。
  assert.equal(matchesFilter({ status: 'BLOCKED' }, 'error'), false, '阻塞应归自己的胶囊，不算异常')
  assert.equal(matchesFilter({ status: 'WAIT_CONFIRM' }, 'error'), false)
  assert.equal(matchesFilter({ status: 'WAIT_CONFIRM' }, 'waitConfirm'), true)
  assert.equal(matchesFilter({ status: 'SUCCESS' }, 'success'), true)
  // 「全部」不做任何排除。
  for (const status of ['START', 'RUNNING', 'WAIT_CONFIRM', 'SUCCESS', 'ERROR', 'BLOCKED']) {
    assert.equal(matchesFilter({ status }, 'all'), true)
  }
})

check('六种筛选的中文标签齐备（用户点名的四个 + 全部 + 阻塞）', () => {
  assert.equal(TASK_FILTER_LABEL.all, '全部')
  assert.equal(TASK_FILTER_LABEL.running, '进行中')
  assert.equal(TASK_FILTER_LABEL.waitConfirm, '待确认')
  assert.equal(TASK_FILTER_LABEL.success, '完成')
  assert.equal(TASK_FILTER_LABEL.error, '异常')
  assert.equal(TASK_FILTER_LABEL.blocked, '阻塞')
})

check('统计胶囊本身就是筛选按钮（不额外新增一行同名按钮）', () => {
  const html = render(TaskPanel, panelProps())
  // 只有一排 .tp-stats，且每个胶囊都是 <button>（用户点名的四个状态都在其中）。
  assert.ok(html.includes('tp-stats'), '应有统计行')
  assert.ok(!html.includes('tp-filters'), '不应再另起一行筛选按钮')
  assert.ok(!html.includes('tp-filter"'), '旧的筛选按钮类名不应残留')
  for (const label of ['运行', '确认', '完成', '异常']) {
    assert.ok(html.includes(label), `统计胶囊应包含「${label}」`)
  }
  // 胶囊是可点击的按钮，且带计数。
  assert.ok(/<button[^>]*class="tp-stat"[^>]*>/.test(html), `胶囊应为按钮，实际：${html.slice(0, 600)}`)
  assert.ok(/运行\s*1/.test(html), '胶囊应显示条数')
})

check('未选中任何筛选时按钮不显示按下态；默认展示全部', () => {
  const html = render(TaskPanel, panelProps())
  // 默认 filter === 'all'，因此没有任何状态胶囊处于 aria-pressed=true。
  assert.ok(!/class="tp-stat"[^>]*aria-pressed="true"/.test(html), '默认不应有选中态胶囊')
})

// 用户原话：「点击『运行』『确认』『完成』『异常』中的任意一个时，选项末尾会多出
// 一个『全部』，需要去掉」。断言渲染出的统计行里**任何情况下**都不含「全部」，
// 防止那枚追加胶囊被加回来。
check('统计行末尾不再追加「✕ 全部 N」胶囊', () => {
  const html = render(TaskPanel, panelProps())

  // 1) 整份渲染里不得出现退出胶囊的类名或文案。
  assert.ok(!html.includes('tp-stat-reset'), '「全部」退出胶囊的类名不应再出现')
  assert.ok(!/✕\s*全部/.test(html), '不应再渲染「✕ 全部 N」')

  // 2) 精确到统计行本身：从 .tp-stats 到 .tp-body 之间不得出现「全部」二字。
  //    这比「类名不存在」更强 —— 换一种写法重新塞进去也会被抓到。
  const statsStart = html.indexOf('tp-stats')
  const bodyStart = html.indexOf('tp-body')
  assert.ok(statsStart > 0 && bodyStart > statsStart, '统计行与面板体都应存在')
  const statsRow = html.slice(statsStart, bodyStart)
  assert.ok(!statsRow.includes('全部'), `统计行内不应出现「全部」，实际：${statsRow}`)

  // 3) 统计行里的按钮数必须恰好等于渲染出的状态胶囊数（没有第六枚按钮）。
  const pills = statsRow.match(/class="tp-stat"/g) ?? []
  const buttons = statsRow.match(/<button/g) ?? []
  assert.equal(buttons.length, pills.length, '统计行内除状态胶囊外不应有其它按钮')

  // 4) 源码级：追加胶囊的代码块与依赖它的条件分支都已删除。
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'TaskPanel.tsx'), 'utf8')
  assert.ok(!/tp-stat-reset/.test(source), 'TaskPanel 源码不应再引用退出胶囊类名')
  assert.ok(!/filter !== 'all' &&/.test(source), '不再有「筛选生效时追加按钮」的条件分支')
  // 退出口仍然存在：再点一次已选中的胶囊即取消筛选。
  assert.ok(/setFilter\(active \? 'all' : pill\.key\)/.test(source), '再次点击选中胶囊应取消筛选')
})

// 上面那条断言的是「初始渲染」。用户报告的场景发生在**点击之后**，所以还要证明
// 点击改变的是哪一枚胶囊被按下，而**不是**渲染出哪些胶囊 —— 只要 `filter` 不参与
// 胶囊的渲染条件，点击后就不可能凭空多出一枚。
// 没有 DOM 环境（仓库刻意不引入 jsdom），因此这里把「渲染条件」从源码结构上锁死：
// 统计行 JSX 内除了 `pill.key === 'blocked' && count === 0` 这一个 return null，
// 不得再有其它以 `filter` 为条件的提前返回。
check('点击筛选后不会追加胶囊：filter 不参与胶囊的渲染条件', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'TaskPanel.tsx'), 'utf8')
  const open = source.indexOf('<div className="tp-stats"')
  const close = source.indexOf('<div className="tp-body"')
  assert.ok(open > 0 && close > open, '应能定位统计行 JSX')
  const statsJsx = source.slice(open, close)

  // 渲染条件里出现 filter 的地方，只能用于 aria-pressed / title / onClick（外观与行为），
  // 任何 `filter ... return null` / `filter ... &&` 形式的渲染开关都是缺陷。
  const earlyReturns = statsJsx.match(/if\s*\([^)]*filter[^)]*\)/g) ?? []
  assert.deepEqual(earlyReturns, [], `统计行内不应有以 filter 为条件的提前返回，实际：${earlyReturns.join(' | ')}`)
  // JSX 里以 filter 开头的表达式容器 = 渲染开关（`{filter !== 'all' && (<button…/>)}`）。
  // `const active = filter === pill.key` 这类赋值不算 —— 它只决定外观。
  const filterGatedBlocks = statsJsx.match(/\{\s*filter[^}]*&&/g) ?? []
  assert.deepEqual(filterGatedBlocks, [], `统计行内不应有以 filter 为条件的渲染块，实际：${filterGatedBlocks.join(' | ')}`)

  // 唯一允许的渲染开关是「阻塞为 0 时不占位置」，与当前筛选无关。
  const guards = statsJsx.match(/if\s*\([^)]*\)\s*return null/g) ?? []
  assert.deepEqual(
    guards.map((g) => g.replace(/\s+/g, ' ').trim()),
    ["if (pill.key === 'blocked' && count === 0) return null"],
    `只允许「阻塞为 0 时不渲染」这一个渲染开关，实际：${guards.join(' | ')}`
  )

  // filter 仍然被用到 —— 但只以 `active`（外观）的形式，证明筛选功能没有被删掉。
  assert.ok(/const active = filter === pill\.key/.test(statsJsx), 'filter 应仍参与选中态判定')
})

check('计数为 0 的胶囊被禁用（点了没结果不如点不动）', () => {
  // 只有 RUNNING 与 SUCCESS 两条 ⇒ 待确认/异常/阻塞 均应为 0 并禁用。
  const html = render(TaskPanel, panelProps())
  const disabled = html.match(/class="tp-stat"[^>]*disabled/g) ?? []
  assert.ok(disabled.length >= 2, `计数为 0 的胶囊应被禁用，实际禁用 ${disabled.length} 个`)
  // 阻塞为 0 时整枚胶囊不渲染（平时不占位置）。
  assert.ok(!html.includes('🟠'), '无阻塞任务时不应出现阻塞胶囊')
})

check('筛选无结果时给出可撤销的空态，而不是整片空白', () => {
  // 构造列表被筛空的场景：直接调 TaskPanel 无法摆弄内部 state，
  // 因此这里退一步断言「空态文案存在」这一实现约定（源码级）。
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'TaskPanel.tsx'), 'utf8')
  assert.ok(/没有「.+」状态的任务/.test(source), '筛选无结果应有明确文案')
  assert.ok(/visibleTasks\.length === 0/.test(source), '空态判定应基于筛选后的列表')
  // 空态必须能被撤销：统计行在滚动区之外渲染，不会随列表一起消失。
  assert.ok(
    source.indexOf('className="tp-stats"') < source.indexOf('<div className="tp-body">'),
    '统计/筛选行必须在滚动区之外，否则列表空了就再也点不回全部'
  )
  // 再点一次已选中的胶囊即可退出筛选（active ? 'all' : key）。
  assert.ok(/setFilter\(active \? 'all' : pill\.key\)/.test(source), '再次点击选中胶囊应取消筛选')
})

// ---- 6b. 用户要求删除的那三个页签按钮不得复活 ----
check('统计行下方不再有「任务/待确认/历史」三个页签按钮', () => {
  // 用户原话：「删除「运行、确认、完成、异常」四个按钮下方的那三个按钮
  // （任务、待确认、历史），删除后该区域只保留这四个按钮」。
  const html = render(TaskPanel, panelProps())
  assert.ok(!html.includes('tp-tabs'), `不应再渲染页签容器，实际：${html.slice(0, 800)}`)
  assert.ok(!html.includes('tp-tab"'), '不应再有页签按钮')
  assert.ok(!html.includes('role="tab"'), '不应再有 tab 角色')
  // 页签上的文案也不得残留成别的按钮：只应有统计胶囊那一排按钮。
  assert.ok(!/历史\s*\d/.test(html), '不应出现「历史 N」按钮文案')
  // 统计行下方紧邻的就是面板体（滚动区），中间没有第二排按钮或别的小组件。
  const statsStart = html.indexOf('tp-stats')
  const bodyStart = html.indexOf('tp-body')
  assert.ok(bodyStart > 0, '面板体必须存在')
  assert.ok(statsStart > 0 && statsStart < bodyStart, '统计行必须在面板体之前')
  const between = html.slice(statsStart, bodyStart)
  const classes = new Set((between.match(/tp-[a-z-]+/g) ?? []))
  assert.deepEqual(
    [...classes].sort(),
    ['tp-stat', 'tp-stats'],
    `统计行与面板体之间不应插入其它控件，实际类名：${[...classes].join(', ')}`
  )

  // 源码级：Tab 类型与 tab 状态一并删除，防止有人只删 DOM 不删逻辑。
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'TaskPanel.tsx'), 'utf8')
  assert.ok(!/type Tab\s*=/.test(source), 'Tab 类型应删除')
  assert.ok(!/useState<Tab>/.test(source), 'tab 状态应删除')
  assert.ok(!/setTab\(/.test(source), 'setTab 调用应删除')
})

// ---- 7. 面板定位由外部注入（胶囊拖动后仍完整可见） ----
check('TaskPanel 接受 panelStyle 并施加到面板根元素', () => {
  const html = render(TaskPanel, panelProps({ panelStyle: { top: -608, left: -240, maxHeight: 596 } }))
  assert.ok(/style="[^"]*top:\s*-608px/.test(html), `面板应施加注入的 top，实际：${html.slice(0, 300)}`)
  assert.ok(/max-height:\s*596px/.test(html), '面板应施加注入的高度上限')
})

rmSync(outdir, { recursive: true, force: true })

console.log(`\n全部 ${passed} 项通过。`)

/** 造一份能渲染出「全部」筛选按钮的 TaskPanel props（含各种状态各一条）。 */
function panelProps(overrides = {}) {
  const now = Date.now()
  const task = (status, i) =>
    makeTask({
      id: `s${i}`,
      sessionId: `s${i}`,
      title: `对话 ${i}`,
      status,
      // 只有跑着的任务才有本轮起点；已结束的进程外会话起点未知。
      runStartedAt: status === 'RUNNING' ? now - 60 * 1000 : null,
      finishedAt: status === 'SUCCESS' ? now - 1000 : null
    })
  return {
    workspaces: [
      { id: 'w1', name: 'GoldPulse', path: '/x', conversationCount: 3, counts: {}, updatedAt: now }
    ],
    tasks: [task('RUNNING', 1), task('SUCCESS', 2)],
    history: [],
    now,
    hostOnline: true,
    onClose: () => {},
    onRefresh: () => {},
    ...overrides
  }
}

/** 从 HTML 里把「运行: / 耗时:」后面的文本抠出来，用于失败信息。 */
function extractDuration(html) {
  const match = /(运行|耗时):\s*<\/span>([^<]*)</.exec(html) ?? /(运行|耗时):\s*([^<]*)/.exec(html)
  return match === null ? '(未找到耗时字段)' : match[0]
}
