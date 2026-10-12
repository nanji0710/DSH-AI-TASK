/**
 * 把源 PNG 图标内联成 TS 常量模块。
 *
 * 为什么要有这一步：
 *   客户端 bundle 的 esbuild 配置刻意不引入任何资源 loader（`scripts/build-client.mjs`
 *   只外置平台 seed、不做 assets 处理）。为一个 16px 的入口图标去加
 *   `loader: {'.png':'dataurl'}`，等于给构建链引入一条隐式依赖：谁在别处
 *   误 import 一个大图，体积会毫无预警地膨胀进 bundle。
 *   改成生成 `.ts` 常量后，图标和 react 一样是普通的可被 tsc 检查的模块，
 *   体积变化在 diff 里一眼可见。
 *
 * 用法：
 *   node scripts/embed-icon.mjs <源PNG> [目标TS] [边长]
 *
 * 仓库里已提交 `src/assets/taskpulse-icon.png`（设计稿等比缩到 256x256 的母版，
 * 保留原图的透明留白）。**不依赖用户桌面的原始文件**也能重跑，且是幂等的：
 *   node scripts/embed-icon.mjs src/assets/taskpulse-icon.png
 * 换成新设计稿时把新原图传进来并覆盖母版即可：
 *   node scripts/embed-icon.mjs "C:\Users\me\Desktop\新图标.png" src/assets/taskpulse-icon.png 256
 *
 * ⚠️ 母版必须是**上游素材**，不能是本脚本的 64px 产物：那已被裁紧过一次，
 *    再跑一遍会二次裁切而缓慢漂移（实测 64px → crop 55x63 → 画面被切掉一边）。
 *
 * 默认行为（与仓库内已提交产物一致）：裁掉完全透明的外圈 → LANCZOS 缩到
 * 64x64 → base64 → 写 `src/assets/taskpulse-icon.ts`。
 *
 * 依赖 PIL。本机可用的是 DSH 捆绑的 Python：
 *   C:\Users\RED CHAMBER\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe
 * 因此图像处理那段交给 Python 子进程，本脚本只负责编排与写文件 ——
 * 避免在 Node 侧再引入 sharp/jimp 这类原生依赖。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

const [, , sourceArg, targetArg, sizeArg] = process.argv

if (sourceArg === undefined) {
  console.error('用法: node scripts/embed-icon.mjs <源PNG> [目标TS] [边长]')
  process.exit(1)
}

const source = resolve(sourceArg)
const target = resolve(targetArg ?? 'src/assets/taskpulse-icon.ts')
const size = Number(sizeArg ?? 64)

if (!existsSync(source)) {
  console.error(`源图不存在: ${source}`)
  process.exit(1)
}
if (!Number.isFinite(size) || size <= 0) {
  console.error(`边长必须是正数: ${sizeArg}`)
  process.exit(1)
}

// 与工程其余部分一致：优先用 DSH 捆绑的 Python，它一定带 PIL。
const python = process.env.TASKPULSE_PYTHON
  ?? 'C:\\Users\\RED CHAMBER\\.dsh\\dsh-runtimes\\dsh-primary-runtime\\dependencies\\python\\python.exe'

/** 用 Python 读源图、按 alpha 裁边、缩放并打印尺寸与 base64。 */
const SCRIPT = `
import base64, io, json, sys
from PIL import Image

src, size = sys.argv[1], int(sys.argv[2])
im = Image.open(src).convert("RGBA")
raw = im.size

# 按 alpha 包围盒裁掉透明外圈 —— 否则图标在胶囊里会显得又小又偏。
bbox = im.getchannel("A").getbbox()
if bbox is not None:
    im = im.crop(bbox)
cropped = im.size

im = im.resize((size, size), Image.LANCZOS)
buf = io.BytesIO()
im.save(buf, format="PNG", optimize=True)
payload = base64.b64encode(buf.getvalue()).decode("ascii")

print(json.dumps({"raw": raw, "cropped": cropped, "bytes": len(buf.getvalue()), "b64": payload}))
`

let parsed
try {
  const stdout = execFileSync(python, ['-c', SCRIPT, source, String(size)], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024
  })
  parsed = JSON.parse(stdout.trim())
} catch (error) {
  console.error('调用 Python/PIL 失败。请确认 TASKPULSE_PYTHON 指向一个装了 Pillow 的解释器。')
  console.error(String(error.stderr ?? error.message ?? error))
  process.exit(1)
}

const { raw, cropped, bytes, b64 } = parsed
const dataUri = `data:image/png;base64,${b64}`

const module = `/**
 * TaskPulse 入口图标（需求 6）。
 *
 * 由 \`scripts/embed-icon.mjs\` 生成，**请勿手改** —— 要换图标就重跑脚本。
 *
 * 源图：\`${source}\`（${raw[0]}x${raw[1]} RGBA）。
 * 先按 alpha 包围盒裁掉透明外圈（⇒ ${cropped[0]}x${cropped[1]}），
 * 再 LANCZOS 缩到 ${size}x${size}（${bytes} B），以 data URI 内联。
 *
 * 尺寸取舍：胶囊侧图标实际渲染约 18px，${size}px 足够覆盖 2x~3x 高清屏；
 * 再大的档位（96px→15.6KB、128px→24.7KB base64）对 16px 的显示是纯浪费。
 */

/** 入口图标 data URI（PNG ${size}x${size}）。 */
export const TASKPULSE_ICON = '${dataUri}'
`

mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, module, 'utf8')

console.log(`[embed-icon] ${source}`)
console.log(`[embed-icon] ${raw[0]}x${raw[1]} -> crop ${cropped[0]}x${cropped[1]} -> ${size}x${size} (${bytes} B)`)
console.log(`[embed-icon] -> ${target} (${module.length} 字符)`)
