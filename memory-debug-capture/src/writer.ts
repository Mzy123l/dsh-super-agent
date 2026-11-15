/**
 * JSONL 追加写：异步队列 + 异步 flush + 进程退出前排空。
 *
 * 设计要点：
 * 1. **不阻塞模型请求**：`enqueue()` 只把行推进内存队列就返回，绝不做磁盘 I/O。
 * 2. **顺序保证**：队列是 FIFO，单个后台消费者按入队顺序写，因此**同一 session 的行
 *    严格按捕获顺序落盘**。
 * 3. **退出前排空**：`flush()` 等待队列清空并把文件刷到磁盘；插件在 dispose 时调用它。
 * 4. **不吞错**：写失败会记到 `lastError` 并通过 `onError` 回调上报，不抛出到调用方
 *    （采集失败绝不能影响模型请求）。
 */

import { createWriteStream, type WriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'

/** 写入器的配置。 */
export interface WriterOptions {
  /** 输出目录；默认 `./captures/`。 */
  outDir: string
  /** 文件名；默认 `capture-<runId>.jsonl`。 */
  fileName?: string
  /** 写失败时的回调（默认静默）。 */
  onError?: (error: unknown) => void
}

/** JSONL 追加写器。 */
export class JsonlWriter {
  /** 输出目录。 */
  readonly outDir: string
  /** 目标文件的绝对路径。 */
  readonly filePath: string

  /** 待写队列（行文本，不含换行）。 */
  private readonly queue: string[] = []
  /** 消费者是否正在跑。 */
  private draining = false
  /** 消费者结束时的通知器。 */
  private idleWaiters: (() => void)[] = []
  /** 底层写流；未打开时为 undefined。 */
  private stream: WriteStream | undefined
  /** 写流打开中的 promise，保证只开一次。 */
  private opening: Promise<WriteStream> | undefined
  /** 最近一次写错误。 */
  private lastError: unknown
  /** 是否已关闭（flush 之后再 enqueue 会拒绝）。 */
  private closed = false
  /** 已写入的行数。 */
  private written = 0
  /** 写错误回调。 */
  private readonly onError: (error: unknown) => void

  constructor(options: WriterOptions) {
    this.outDir = options.outDir
    this.onError = options.onError ?? (() => {})
    this.filePath = join(this.outDir, options.fileName ?? 'capture.jsonl')
  }

  /** 最近一次写错误（没有则为 undefined）。 */
  get error(): unknown {
    return this.lastError
  }

  /** 已成功写入的行数。 */
  get count(): number {
    return this.written
  }

  /** 队列中待写的行数。 */
  get pending(): number {
    return this.queue.length
  }

  /**
   * 把一行记录推进队列。**不做磁盘 I/O**，因此可以安全地在模型请求路径上调用。
   *
   * @param record - 要落盘的记录。
   */
  enqueue(record: unknown): void {
    if (this.closed) return
    let line: string
    try {
      line = JSON.stringify(record)
    } catch (error) {
      this.lastError = error
      this.onError(error)
      return
    }
    this.queue.push(line)
    void this.drain()
  }

  /**
   * 打开（必要时）底层写流。
   *
   * @returns 写流。
   */
  private async open(): Promise<WriteStream> {
    if (this.stream !== undefined) return this.stream
    this.opening ??= (async () => {
      await mkdir(dirname(this.filePath), { recursive: true })
      // `flags: 'a'` 是追加语义：多个进程/多次运行写同一个文件不会互相截断。
      const stream = createWriteStream(this.filePath, { flags: 'a' })
      const failed = new Promise<never>((_resolve, reject) => {
        stream.once('error', reject)
      })
      await Promise.race([
        new Promise<void>((resolve) => stream.once('open', () => resolve())),
        failed,
      ])
      this.stream = stream
      return stream
    })()
    return this.opening
  }

  /**
   * 把一行写进文件。
   *
   * @param line - JSON 文本。
   */
  private async writeLine(line: string): Promise<void> {
    const stream = await this.open()
    await new Promise<void>((resolve, reject) => {
      stream.write(`${line}\n`, (error) => {
        if (error) reject(error)
        else resolve()
      })
    })
    this.written += 1
  }

  /**
   * 消费者循环：把队列里的行依次写出。
   *
   * 单消费者保证顺序；写失败时把该行留在队首并停下，避免顺序错乱。
   */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      while (this.queue.length > 0) {
        const line = this.queue[0] as string
        try {
          await this.writeLine(line)
          this.queue.shift()
        } catch (error) {
          this.lastError = error
          this.onError(error)
          // 保留队首，稍后重试；停止本轮消费，避免在错误状态下刷屏。
          break
        }
      }
    } finally {
      this.draining = false
      this.releaseIdleWaiters()
    }
  }

  /** 通知等待队列清空的调用方。 */
  private releaseIdleWaiters(): void {
    if (this.queue.length > 0) return
    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const waiter of waiters) waiter()
  }

  /**
   * 等待队列排空，并把内容刷到磁盘。
   *
   * @param timeoutMs - 最长等待时间；超时则放弃等待（不抛错）。
   * @returns 是否在超时前排空。
   */
  async flush(timeoutMs = 5_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs
    while (this.queue.length > 0 || this.draining) {
      if (Date.now() >= deadline) return false
      await new Promise<void>((resolve) => {
        this.idleWaiters.push(resolve)
        // 队列可能刚好在注册等待者之前被排空，这里补一次检查。
        if (this.queue.length === 0 && !this.draining) this.releaseIdleWaiters()
      })
    }
    // 内容已经进入写流，再等一次 drain 结束确保 write 回调都回来了。
    await new Promise<void>((resolve) => {
      setImmediate(resolve)
    })
    const stream = this.stream
    if (stream === undefined) return true
    await new Promise<void>((resolve) => {
      stream.write('', () => resolve())
    })
    return true
  }

  /**
   * 关闭写者：先排空，再结束写流。
   *
   * @param timeoutMs - 最长等待时间。
   */
  async close(timeoutMs = 5_000): Promise<void> {
    await this.flush(timeoutMs)
    this.closed = true
    const stream = this.stream
    this.stream = undefined
    this.opening = undefined
    if (stream === undefined) return
    await new Promise<void>((resolve) => {
      stream.end(() => resolve())
    })
  }
}
