/**
 * 浏览器半边 bundle 契约自检。
 *
 * 验证的是**加载契约**，而不是组件渲染细节 —— 契约错了整个插件 fiber 会直接
 * FAILED，且报错发生在 DSH 内部，极难定位。因此这里在 Node 里重现 DSH 的
 * `window.__ModuleLoader__` 环境，把 dist/client/index.js 真正跑一遍：
 *
 *   1. bundle 是否调用 __ModuleLoader__.load 且 id 等于包名；
 *   2. factory 被 require 的几个 id 是否全部落在页面的冻结 seed 表里；
 *   3. 导出的 name / inject / apply 形状是否符合客户端插件契约；
 *   4. apply() 是否用「正确的槽位键 + 正确的注册字段」调用 ctx.slots；
 *   5. 组件是否是合法的函数组件，且能安全渲染出右上角浮窗结构。
 *
 * 运行：npm run test:bundle
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import vm from 'node:vm'

const BUNDLE = 'dist/client/index.js'
const PACKAGE_NAME = 'dsh-taskpulse'
const SLOT = 'shell.overlay'

/** 页面启动时冻结的 9 个平台模块（唯一允许被 bundle require 的裸 id）。 */
const PLATFORM_SEED = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
])

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

const require = createRequire(import.meta.url)

/** 真正的加载模拟：捕获 load() 调用，用宿主注入的 require 执行 factory。 */
const registrations = []
const requestedSpecs = new Set()
const blocked = new Set()

const sandbox = {
  window: {
    __ModuleLoader__: {
      load(registration) {
        registrations.push(registration)
      }
    }
  },
  document: undefined,
  console,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
}
sandbox.globalThis = sandbox

const source = readFileSync(BUNDLE, 'utf8')
// 不传 document（模拟尚未挂载的极端情况）：ensureStyles 必须自行短路，不能抛。
vm.createContext(sandbox)
vm.runInContext(source, sandbox, { filename: BUNDLE })

console.log('浏览器半边 bundle 契约自检')

check('bundle 通过 __ModuleLoader__.load 注册且 id 等于包名', () => {
  assert.equal(registrations.length, 1, `应恰好注册 1 次，实际 ${registrations.length}`)
  assert.equal(registrations[0].id, PACKAGE_NAME)
  assert.equal(typeof registrations[0].factory, 'function', 'factory 必须是函数')
})

const registration = registrations[0]

/** 宿主提供的 require：只允许 seed 表内的 id。 */
function hostRequire(spec) {
  requestedSpecs.add(spec)
  if (!PLATFORM_SEED.has(spec)) blocked.add(spec)
  return require(spec)
}

const exports = registration.factory(hostRequire)

check('factory 只 require 冻结 seed 表内的模块', () => {
  assert.deepEqual([...blocked], [], `以下 id 不在平台 seed 表内，运行时会抛 missed the module table: ${[...blocked].join(', ')}`)
  for (const spec of requestedSpecs) {
    assert.ok(PLATFORM_SEED.has(spec), `${spec} 不在 seed 表内`)
  }
})

check('导出形状符合客户端插件契约', () => {
  assert.equal(exports.name, PACKAGE_NAME, 'name 必须等于包名')
  assert.ok(Array.isArray(exports.inject), 'inject 必须是数组')
  // ⚠️ 不要用 deepEqual 比较这些数组：它们来自 vm 沙箱（另一个 realm），
  //    原型是沙箱的 Array.prototype，deepStrictEqual 会因原型不同而误报失败。
  //    逐元素 + 长度比较才是对的。
  assert.equal(exports.inject.length, 1, 'inject 应恰好声明 1 个服务')
  assert.equal(exports.inject[0], 'slots', 'inject 必须声明 slots 服务名，否则 ctx.slots 代理 getter 会抛错')
  assert.equal(typeof exports.apply, 'function', 'apply 必须是函数')
  assert.equal(typeof exports.default, 'object', 'default 导出对象')
  assert.equal(exports.default.name, PACKAGE_NAME)
  assert.equal(exports.default.inject.length, 1)
  assert.equal(exports.default.inject[0], 'slots')
  assert.equal(typeof exports.default.apply, 'function')
})

check('导出 TaskPulseOverlay 组件（供测试与复用）', () => {
  assert.equal(typeof exports.TaskPulseOverlay, 'function')
})

check('apply() 用 ctx.slots.inject 等待槽位声明后再注册（避免加载顺序竞态）', () => {
  const injectedKeys = []
  let registered = null
  const ctx = {
    slots: {
      inject(key, callback) {
        injectedKeys.push(key)
        // 真实渲染器会把回调推迟到父条目声明槽位之后执行。
        return callback()
      },
      register(options, component) {
        registered = { options, component }
        return () => {}
      }
    }
  }

  assert.doesNotThrow(() => exports.apply(ctx), 'apply 不得抛异常')
  assert.deepEqual(injectedKeys, [SLOT], `必须先 inject 槽位 ${SLOT}`)
  assert.ok(registered !== null, '必须注册一个条目')
  assert.equal(registered.options.name, SLOT)
  assert.equal(typeof registered.options.id, 'string')
  assert.ok(registered.options.id.length > 0, 'list 插槽的条目必须带 id')
  assert.equal(typeof registered.options.order, 'number')
  assert.equal(typeof registered.component, 'function', '组件必须是函数')
})

check('apply() 在 document 缺失时也不崩（ensureStyles 自行短路）', () => {
  const ctx = { slots: { inject: (_k, cb) => cb(), register: () => () => {} } }
  assert.doesNotThrow(() => exports.apply(ctx))
})

check('组件可在无标准 props 的环境下安全渲染（退化路径）', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  // 不传 useSessions / useSessionStatus / useWorkspaces：等价于标准源缺失。
  const html = renderToStaticMarkup(React.createElement(exports.TaskPulseOverlay, {}))
  assert.ok(html.includes('tp-root'), '应渲染出 tp-root 容器')
  assert.ok(html.includes('AI任务'), '默认态应展示「AI任务」入口')
  assert.ok(!html.includes('tp-panel'), '默认收起，不应渲染面板')
})

check('组件在标准 props 齐全时渲染出任务入口与计数', () => {
  const React = require('react')
  const { renderToStaticMarkup } = require('react-dom/server')
  const sessionsSnapshot = {
    ids: ['s1', 's2'],
    byId: {
      s1: { id: 's1', displayTitle: '构建插件', running: true, updatedAt: Date.now() },
      s2: { id: 's2', displayTitle: '等待确认的改动', updatedAt: Date.now() }
    }
  }
  const props = {
    useSessions: (selector) => selector(sessionsSnapshot),
    useSessionStatus: (selector) =>
      selector(
        new Map([
          ['s1', { running: true }],
          ['s2', { running: false, pendingInteraction: { kind: 'approval' } }]
        ])
      ),
    useWorkspaces: (selector) => selector({ items: [] })
  }
  const html = renderToStaticMarkup(React.createElement(exports.TaskPulseOverlay, props))
  assert.ok(html.includes('tp-btn'), '应渲染入口按钮')
  assert.ok(html.includes('tp-btn-count'), '入口应带任务计数徽章')
})

console.log(`\n全部 ${passed} 项通过。`)
