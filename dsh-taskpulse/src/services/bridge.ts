/**
 * BridgeService —— 宿主半边 ↔ 浏览器半边的唯一通道（规范 5 事件流的跨半边段）。
 *
 * 为什么必须自建通道：`ctx.remote.$on` 的键集是**封闭白名单**
 * （`@deepseek-ai/dsh-api-remotes` 的 API_REMOTE_FORWARDED_EVENTS，27 项），
 * 里面没有 `session/event` / `tool/call` / `turn/start` —— 浏览器半边
 * 永远拿不到 Timeline 所需的会话事件。因此宿主半边把归约好的任务快照
 * 通过 `connection.fetch.register` 暴露给同源页面。
 *
 * ⚠️ 死路备忘：**不要**用 `connection.rpc.handle()` / `rpc.call()`。
 * 其内部执行 `owner.effect(() => owner.webServer.register(route))`，而 owner 经
 * Cordis traceable 转发后拿不到 `webServer`，抛
 * `cannot get property "webServer" without inject` 并被吞掉 ⇒ 通道静默失效
 * （端点恒 404/405）。`connection.fetch.register` 不触碰 owner.webServer。
 */

import type { DetailResponse, HistoryResponse } from '../models'
import type { TaskService } from './task-service'

/** 端点前缀：必须 `/api/` 开头，且每段匹配 /^[A-Za-z0-9_$.-]+$/。 */
export const API_PREFIX = '/api/dsh-taskpulse'

export interface BridgeServiceDeps {
  ctx: any
  service: TaskService
}

export class BridgeService {
  private readonly ctx: any
  private readonly service: TaskService
  private disposers: Array<() => void> = []

  constructor(deps: BridgeServiceDeps) {
    this.ctx = deps.ctx
    this.service = deps.service
  }

  /**
   * 注册全部端点。
   *
   * `connection` 是 **web 宿主专有服务**，在非 Web 载体（如纯 CLI）中不存在，
   * 因此必须放在独立的 `ctx.inject` 里，不能写进插件顶层的 `inject` 数组 ——
   * 否则插件在 CLI 下会因等待一个永不出现的服务而卡住。
   */
  start(): void {
    this.ctx.inject(['connection'], (connCtx: any) => {
      const connection = connCtx.connection
      if (connection?.fetch?.register === undefined) {
        this.ctx.logger?.warn?.('[taskpulse] connection.fetch 不可用，浏览器半边将退化为本地状态源')
        return
      }
      this.registerRoutes(connection)
    })
  }

  /** 卸载：回收所有端点。 */
  stop(): void {
    for (const dispose of this.disposers) {
      try {
        dispose()
      } catch {
        /* 回收失败不应影响插件卸载 */
      }
    }
    this.disposers = []
  }

  private registerRoutes(connection: any): void {
    // 任务快照：活跃任务 + 工作区聚合 + 统计 + 待确认（一次请求拿全，避免多次往返）。
    this.register(connection, `${API_PREFIX}/snapshot`, async () => {
      const details = this.service.getActiveTasks()
      return {
        ok: true,
        stats: this.service.getStats(),
        workspaces: this.service.getWorkspaces(),
        details,
        conversations: this.service.getConversations(),
        pending: this.service.listPendingConfirms()
      }
    })

    // 历史记录（HistoryCard 数据源）。
    this.register(connection, `${API_PREFIX}/history`, async (): Promise<HistoryResponse> => {
      return { ok: true, items: this.service.listHistory() }
    })

    // 健康检查：浏览器半边据此判断桥是否就绪（未就绪时退化为本地状态源）。
    this.register(connection, `${API_PREFIX}/ping`, async () => ({ ok: true, version: 1 }))
  }

  /** 注册单个 GET 端点；任何异常都转成 `{ ok:false, error }` 且 HTTP 200。 */
  private register(connection: any, path: string, handler: () => Promise<unknown>): void {
    const dispose = connection.fetch.register({
      path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (_request: Request): Promise<Response> => {
        try {
          const body = await handler()
          return json(200, body)
        } catch (error) {
          // 错误不静默：把原因回传浏览器半边，UI 才能显式提示而不是白屏。
          const message = error instanceof Error ? error.message : String(error)
          this.ctx.logger?.warn?.(`[taskpulse] ${path} 失败: ${message}`)
          return json(200, { ok: false, error: message } satisfies DetailResponse)
        }
      }
    })
    if (typeof dispose === 'function') this.disposers.push(dispose)
  }
}

/** 统一 JSON 响应（与参考实现一致，显式 charset）。 */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' }
  })
}
