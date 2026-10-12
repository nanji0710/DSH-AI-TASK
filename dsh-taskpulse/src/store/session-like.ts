/**
 * 宿主侧 Session / SessionEvent 的最小结构类型。
 *
 * 之所以不复用 `@deepseek-ai/dsh-session` 的类型：本插件通过 link 安装时
 * 可能解析到与宿主不同的模块副本，`instanceof` 与私有字段都会失效。
 * 只依赖**结构**，是与宿主解耦且稳定的做法（与参考插件 prompt-optimizer 一致）。
 */

/** 会话事件（`session.append(type, data)` 产出的对象）。 */
export interface SessionEventLike {
  type: string
  /** 事件在会话日志中的序号。 */
  seq?: number
  /** 事件时间（epoch ms）。 */
  time?: number
  data?: unknown
}

/** 宿主 Session 实例的最小面。 */
export interface SessionLike {
  id: string
  title?: string
  header?: Record<string, unknown>
  /** 当前日志长度（下一个事件的 seq）。 */
  seq?: number
  /** 读取事件（不同版本方法名略有差异，运行时按存在性择一）。 */
  snapshotEvents?: (fromSeq?: number, toSeqExclusive?: number) => readonly SessionEventLike[]
  eventAt?: (seq: number) => SessionEventLike | undefined
}

/** 会话目录条目（`api-session/added` 载荷 / 宿主 `ctx.sessions.list()`）。 */
export interface SessionSummaryLike {
  sessionId?: string
  id?: string
  title?: string
  cwd?: string
  updatedAt?: number
  running?: boolean
  parentSessionId?: string
  origin?: string
}
