/**
 * 数据目录解析。
 *
 * 与 DSH 自己的规则保持一致（`@deepseek-ai/dsh-home-paths` 的
 * `resolveDshHome` 优先级）：显式配置 > `$DSH_HOME` > `~/.dsh`。
 *
 * 之所以在本插件内重新实现而不直接 import 那个内部包：本插件通过 `link:`
 * 安装时可能解析到与宿主不同的模块副本，依赖内部包的稳定性没有保证。
 * 这段逻辑只有几行，自己写更可靠。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/** 展开 `~` / `~/` / `~\` 前缀。 */
function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/') || path.startsWith('~\\')) return join(homedir(), path.slice(2))
  return path
}

/** 解析 DSH home；空白的 `$DSH_HOME` 视为未设置。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.DSH_HOME
  const base = configured !== undefined && configured.trim().length > 0
    ? configured
    : join(homedir(), '.dsh')
  return resolve(expandHome(base))
}

/** 本插件的数据目录：`<DSH home>/taskpulse`。 */
export function resolveDataDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveDshHome(env), 'taskpulse')
}
