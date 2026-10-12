/**
 * DSH TaskPulse —— 宿主（Node）半边入口。
 *
 * 职责（严格对齐规范 5 的事件流）：
 *   DSH Event → Event Service → Task Store → (Bridge 推给 UI) → History 保存
 *
 * 本半边**只读**：订阅 DSH 事件、归约任务状态、把快照交给浏览器半边。
 * 按规范 8 的权限设计，它绝不修改用户内容、绝不自动执行操作、绝不代用户
 * 做确认决定 —— 确认中心只展示，确认动作仍由用户在原 UI 完成。
 */

import { EventService } from './services/event-service'
import { BridgeService } from './services/bridge'
import { TaskService } from './services/task-service'
import { HistoryStore } from './store/history-store'
import { TaskStore } from './store/task-store'
import { resolveDataDirectory } from './store/data-directory'

/** 声明依赖的宿主服务（服务名，不是包名）。 */
export const inject = ['workspaceRegistry', 'sessions']

/**
 * 插件主体。
 *
 * @param ctx - 本插件 fiber 的宿主上下文。
 */
export function apply(ctx: any): void {
  const store = new TaskStore()
  const history = new HistoryStore({ directory: resolveDataDirectory() })
  const events = new EventService({ ctx, store })
  const service = new TaskService({ ctx, store, history })
  const bridge = new BridgeService({ ctx, service })

  // 载入历史存档（异步，不阻塞插件就绪；失败不致命）。
  void history.load().catch((error: unknown) => {
    ctx.logger?.warn?.(`[taskpulse] 历史载入失败: ${error instanceof Error ? error.message : String(error)}`)
  })

  events.start()
  bridge.start()

  // 让其它插件可读取任务状态（只读服务，符合规范 8 的权限设计）。
  ctx.provide?.('taskpulse', service)

  // 卸载顺序：先停推送，再停归约，最后回收内存。
  ctx.effect(() => () => {
    bridge.stop()
    events.stop()
    store.dispose()
  }, 'taskpulse: lifecycle')

  ctx.logger?.info?.('[taskpulse] 已启动：右上角任务浮窗与宿主归约器就绪')
}

export default { name: 'dsh-taskpulse', inject, apply }
