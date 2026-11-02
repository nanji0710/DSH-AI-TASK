/**
 * 主题适配自检（深色模式）。
 *
 * 用户报的现象：DSH 深色模式下任务列表里每个工作区分组都是一整块白底，
 * 组标题（工作区名）几乎看不见。
 *
 * 根因不在配色审美，而在**用了一个宿主根本不存在的 token**：
 * 插件原来写 `var(--dsw-alias-fill-l1, #fafafa)`，但 dsh-client-ui-theme
 * 的 alias 表里没有 fill-l1 / fill-l2（只有 bg-layer-1/2/3、bg-overlay、
 * interactive-bg-hover、menu-group-header-fill 等）。变量不存在 ⇒ 永远取
 * fallback #fafafa ⇒ 深色模式下分组容器仍是白底；而组标题文字用的是
 * label-primary，深色主题下是 #f9fafb —— 白字白底，名字直接消失。
 *
 * 这组断言守两件事：
 *   1. 样式只能引用**已核实存在**于 DSH 主题包的变量（白名单见下），
 *      否则 fallback 会在某一套主题下变成「看起来正常但实际是错色」；
 *   2. 凡是写死的规范色（蓝/黄/绿/红/橙）落在深色底上的地方，都必须有
 *      `body[data-ds-dark-theme]` 覆盖，否则深色下对比度不足。
 *
 * 白名单核对方式：在 DSH 安装目录里搜 dsh-client-ui-theme 的主题样式
 * （lib/client.js 里的 `body{...}` 与 `body[data-ds-dark-theme]{...}` 两套
 * alias 变量表），逐个确认 `--token:` 有定义。新增变量前请重复这一步。
 *
 * 运行：npm run test:theme
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cssSource = readFileSync(join(process.cwd(), 'src', 'styles', 'taskpulse-css.ts'), 'utf8')
/** 剥掉注释再断言：注释里提到旧 token 名不应该让测试变红。 */
const css = cssSource.replace(/\/\*[\s\S]*?\*\//g, '')

let passed = 0
function check(name, fn) {
  fn()
  passed += 1
  console.log(`  \u2713 ${name}`)
}

/** 取某选择器规则块的声明体（首个 `{` 到配对 `}`；本样式表没有嵌套块）。 */
function ruleBody(selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const match = css.match(new RegExp(escaped + '\\s*\\{([^}]*)\\}'))
  return match === null ? null : match[1]
}

/**
 * DSH 2.x 主题包真实提供、且插件正在使用的变量白名单。
 * 前 15 个是 `--dsw-alias-*`（会随浅/深主题切换），后 9 个是静态/工具变量。
 */
const HOST_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-button-floating-fill',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-menu-group-header-fill',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--ds-ease-in-out',
  '--ds-transition-duration',
  '--ds-transition-duration-fast',
  '--ds-transition-duration-slow',
  '--dsw-elevation-panel',
  '--dsw-focus-ring-color',
  '--dsw-focus-ring-width',
  '--dsw-font-family',
  '--dsw-menu-backdrop-filter'
])

/** 插件里所有写死的状态色（浅色底挑的饱和色）——深色下必须另有覆盖。 */
const STATUS_TONES = ['blue', 'yellow', 'green', 'red', 'orange']

console.log('主题 token：')

check('不再引用宿主不存在的 --dsw-alias-fill-l1 / fill-l2（深色白底的直接原因）', () => {
  const offenders = css.match(/--dsw-alias-fill-l[12]\b/g) ?? []
  assert.deepEqual(offenders, [], `仍有 ${offenders.length} 处引用了不存在的 fill-l token`)
})

check('引用的每个变量都在已核实的宿主 token 白名单里', () => {
  const used = [...new Set([...css.matchAll(/--(?:dsw|ds)-[a-z0-9-]+/g)].map((m) => m[0]))]
  const unknown = used.filter((token) => !HOST_TOKENS.has(token))
  assert.deepEqual(unknown, [], `出现未核实的变量（宿主可能没定义，深色下会落到 fallback）：${unknown.join(', ')}`)
})

check('工作区分组底色用真实主题 token（浅色 #f8f9fa / 深色 #303136）', () => {
  const body = ruleBody('.tp-group')
  assert.ok(body !== null, '缺少 .tp-group 规则块')
  assert.ok(
    /background:\s*var\(--dsw-alias-menu-group-header-fill/.test(body),
    `.tp-group 必须用 menu-group-header-fill 取底色，实际：${body.trim()}`
  )
})

check('浅色底用字面量、深色会翻转的表面都不再用 fill-l 系列兜底', () => {
  // 这几个表面原来都写 fill-l1/l2：统计胶囊默认底、灰色徽章、进度条轨道、次级按钮。
  for (const [selector, token] of [
    ['.tp-badge[data-tone="gray"]', '--dsw-alias-interactive-bg-hover'],
    ['.tp-progress', '--dsw-alias-border-l2'],
    ['.tp-action', '--dsw-alias-interactive-bg-hover']
  ]) {
    const body = ruleBody(selector)
    assert.ok(body !== null, `缺少 ${selector} 规则块`)
    assert.ok(body.includes(token), `${selector} 应改用 ${token}，实际：${body.trim().slice(0, 120)}`)
  }
})

console.log('深色主题覆盖：')

check('没有依赖 prefers-color-scheme（宿主不切 color-scheme，深色只认 body 属性）', () => {
  assert.ok(!/prefers-color-scheme/.test(css), '不得用媒体查询判定深色，宿主靠 body[data-ds-dark-theme]')
  assert.ok(!/light-dark\(/.test(css), '宿主没设 color-scheme，light-dark() 取不到正确值')
})

check('深色覆盖块存在且覆盖了列表区域的主要元素', () => {
  const darkRules = css.match(/body\[data-ds-dark-theme\]/g) ?? []
  assert.ok(darkRules.length >= 15, `深色覆盖规则太少（${darkRules.length} 条），疑似漏改`)
  for (const selector of ['.tp-group-counts', '.tp-dot', '.tp-progress-bar', '.tp-timeline-mark', '.tp-toast', '.tp-confirm', '.tp-error']) {
    assert.ok(
      new RegExp(`body\\[data-ds-dark-theme\\][^{}]*${selector.replace(/[.[\]"]/g, '\\$&')}`).test(css),
      `深色覆盖缺少 ${selector}`
    )
  }
})

check('五种状态色在深色下都有覆盖（分组计数 + 圆点）', () => {
  for (const tone of STATUS_TONES) {
    assert.ok(
      new RegExp(`body\\[data-ds-dark-theme\\][^{}]*\\.tp-group-counts span\\[data-tone="${tone}"\\]`).test(css),
      `分组计数的 ${tone} 缺少深色覆盖`
    )
    assert.ok(
      new RegExp(`body\\[data-ds-dark-theme\\][^{}]*\\.tp-dot\\[data-tone="${tone}"\\]`).test(css),
      `状态圆点的 ${tone} 缺少深色覆盖`
    )
  }
})

check('深色覆盖优先用主题状态色，而不是再写一份饱和字面量', () => {
  const dark = css.slice(css.indexOf('body[data-ds-dark-theme]'))
  for (const token of ['--dsw-alias-state-business-primary', '--dsw-alias-state-warn-primary', '--dsw-alias-state-success-primary', '--dsw-alias-state-error-primary']) {
    assert.ok(dark.includes(token), `深色覆盖应使用 ${token}`)
  }
})

check('状态徽章与统计胶囊在深色下也有覆盖（浅色淡底不能直接搬到深色卡片上）', () => {
  for (const tone of STATUS_TONES) {
    assert.ok(
      new RegExp(`body\\[data-ds-dark-theme\\][^{}]*\\.tp-badge\\[data-tone="${tone}"\\]`).test(css),
      `状态徽章的 ${tone} 缺少深色覆盖（#dcfce7 这类淡底在深色卡片上会变成发光糖片）`
    )
    assert.ok(
      new RegExp(`body\\[data-ds-dark-theme\\][^{}]*\\.tp-stat\\[data-tone="${tone}"\\]`).test(css),
      `统计胶囊的 ${tone} 缺少深色覆盖`
    )
  }
})

check('深色下的徽章/胶囊改用半透明状态色底，而不是继续写死浅色淡底', () => {
  const dark = css.slice(css.indexOf('body[data-ds-dark-theme]'))
  for (const selector of ['\\.tp-badge', '\\.tp-stat']) {
    for (const tone of STATUS_TONES) {
      const match = dark.match(new RegExp(`${selector}\\[data-tone="${tone}"\\]\\s*\\{([^}]*)\\}`))
      assert.ok(match !== null, `${selector} 的 ${tone} 缺少深色规则体`)
      assert.ok(
        /background:\s*rgba\(/.test(match[1]),
        `${selector} 的 ${tone} 深色底应使用半透明状态色（rgba），实际：${match[1].trim()}`
      )
    }
  }
})

console.log('组件与样式的一致性：')

check('WorkspaceGroup 不再内联写死状态色，改由 data-tone 交给 CSS', () => {
  const source = readFileSync(join(process.cwd(), 'src', 'components', 'WorkspaceGroup.tsx'), 'utf8')
  assert.ok(!/style=\{\{\s*color:/.test(source), '组头计数不应再用内联 color（深色下无法覆盖）')
  for (const tone of STATUS_TONES) {
    assert.ok(source.includes(`data-tone="${tone}"`), `组头计数缺少 data-tone="${tone}"`)
  }
})

check('分组计数的五种 tone 都有浅色规则（否则深色以外的主题会掉色）', () => {
  for (const tone of STATUS_TONES) {
    assert.ok(
      new RegExp(`\\.tp-group-counts span\\[data-tone="${tone}"\\]\\s*\\{[^}]*color:`).test(css),
      `分组计数的 ${tone} 缺少浅色规则`
    )
  }
})

console.log(`\n全部 ${passed} 项通过。`)
