/**
 * History 持久化（规范 6：隐藏后保存 History；规范 7：核心接口 saveHistory()）。
 *
 * 落点：`<DSH data dir>/taskpulse/history.json`。
 * 采用「原子写」（临时文件 + rename），避免进程中断产生半截 JSON。
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { HistoryItem } from '../models'

export interface HistoryStoreOptions {
  /** 数据目录（通常是 DSH 的 storage 根，或插件的私有目录）。 */
  directory: string
  /** 最多保留条数。 */
  limit?: number
}

export class HistoryStore {
  private readonly file: string
  private readonly limit: number
  private items: HistoryItem[] = []
  private loaded = false
  private writing: Promise<void> | null = null
  private dirty = false

  constructor(options: HistoryStoreOptions) {
    this.file = join(options.directory, 'history.json')
    this.limit = options.limit ?? 200
  }

  /** 从磁盘载入（幂等）。 */
  async load(): Promise<HistoryItem[]> {
    if (this.loaded) return this.items
    this.loaded = true
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) this.items = parsed.filter(isHistoryItem).slice(0, this.limit)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code
      if (code !== 'ENOENT') {
        // 损坏的存档不应拖垮插件：留给调用方记录，自己继续以空历史运行。
      }
      this.items = []
    }
    return this.items
  }

  /** 当前历史（内存视图）。 */
  list(): HistoryItem[] {
    return this.items
  }

  /** 追加 / 覆盖一条历史并异步落盘。 */
  async save(item: HistoryItem): Promise<void> {
    const index = this.items.findIndex((existing) => existing.id === item.id)
    if (index >= 0) this.items[index] = item
    else this.items.unshift(item)
    this.items.sort((a, b) => b.finishedAt - a.finishedAt)
    if (this.items.length > this.limit) this.items.length = this.limit
    await this.flush()
  }

  /** 批量保存，供 Store 一次性同步。 */
  async saveAll(items: HistoryItem[]): Promise<void> {
    if (items.length === 0) return
    const map = new Map(this.items.map((item) => [item.id, item]))
    for (const item of items) map.set(item.id, item)
    this.items = [...map.values()].sort((a, b) => b.finishedAt - a.finishedAt).slice(0, this.limit)
    await this.flush()
  }

  /** 落盘（合并并发调用，避免写风暴）。 */
  private async flush(): Promise<void> {
    this.dirty = true
    if (this.writing !== null) return this.writing
    this.writing = (async () => {
      try {
        while (this.dirty) {
          this.dirty = false
          const payload = JSON.stringify(this.items, null, 2)
          await mkdir(dirname(this.file), { recursive: true })
          const temp = `${this.file}.${process.pid}.tmp`
          await writeFile(temp, payload, 'utf8')
          await rename(temp, this.file)
        }
      } finally {
        this.writing = null
      }
    })()
    return this.writing
  }
}

function isHistoryItem(value: unknown): value is HistoryItem {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.id === 'string' && typeof record.title === 'string' && typeof record.finishedAt === 'number'
}
