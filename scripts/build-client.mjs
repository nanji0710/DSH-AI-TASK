// 浏览器半边打包脚本：src/client/index.tsx → dist/client/index.js
//
// DSH 的客户端插件不是 ESM、也不是普通 CJS，而是 __ModuleLoader__.load({id, factory})
// 包装的 factory-form CJS（require 由宿主注入，模块副作用在首次物化时才运行）。
// 因此这里用 esbuild 打成一个 CJS bundle，再用 banner/footer 手工套上那层包装。
//
// ⚠️ external 必须**恰好**等于页面的冻结平台 seed 表。多写一个不在表里的 id
//    （例如裸 `cordis`）会让运行时抛
//    `client-modules: require("...") missed the module table — ... (a build-time externals drift ...)`。
import { build } from 'esbuild'
import { mkdirSync } from 'node:fs'

mkdirSync('dist/client', { recursive: true })

/** 页面启动时冻结的 9 个平台模块（唯一可 require 的裸 id）。 */
const PLATFORM_SEED = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit'
]

await build({
  entryPoints: ['src/client/index.tsx'],
  bundle: true,
  outfile: 'dist/client/index.js',
  platform: 'browser',
  format: 'cjs',
  target: ['chrome110'],
  jsx: 'automatic',
  sourcemap: false,
  minify: false,
  logLevel: 'info',
  external: PLATFORM_SEED,
  // DSH 的加载契约：banner 里的 id 必须等于包名。
  banner: {
    js: 'window.__ModuleLoader__.load({id:"dsh-taskpulse", factory:(require)=>{var module={exports:{}};'
  },
  footer: {
    js: 'return module.exports}})'
  }
})

console.log('[build] client bundle -> dist/client/index.js')
