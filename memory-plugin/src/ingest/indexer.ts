// 索引器：扫描会话目录 → 解压 → 提取 → 写库 + FTS + 向量双通道（规格 §1 ingest）
//
// 决策②：不读 dsh 内置 session-query，直接读原始日志文件，
// 把数据复制到插件自己的数据目录（本模块的 MemoryStore）。
// 决策④：本模块只被动索引，无任何自动触发。

import { readdirSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'
import { readSessionLog } from './log-reader.js'
import { extractFromEvents } from './extractor.js'
import { MemoryStore } from '../store/sqlite.js'
import { NoopVectorStore } from '../search/vector.js'
import type {
  IndexerConfig,
  MemoryRecord,
  ReasoningRecord,
  SessionWatermark,
  VectorRecordId,
} from '../types.js'
import type { VectorStore } from '../types.js'

/** 一个会话文件的定位结果 */
interface SessionFile {
  sessionId: string
  filePath: string
  mtimeMs: number
}

/**
 * 扫描 sessions 根目录：`<cwd>/session-<id>/session.v4.jsonl.zstd`。
 * 一级目录是 cwd 转义名，二级目录是 session-`<id>`，文件名固定。
 * 只读，绝不修改原文件。
 */
export function discoverSessionFiles(sessionsDir: string): SessionFile[] {
  const files: SessionFile[] = []
  let topDirs: string[]
  try {
    topDirs = readdirSync(sessionsDir)
  } catch {
    return files
  }
  for (const top of topDirs) {
    const topPath = join(sessionsDir, top)
    let subDirs: string[]
    try {
      if (!statSync(topPath).isDirectory()) continue
      subDirs = readdirSync(topPath)
    } catch {
      continue
    }
    for (const sub of subDirs) {
      if (!sub.startsWith('session-')) continue
      const filePath = join(topPath, sub, 'session.v4.jsonl.zstd')
      try {
        const st = statSync(filePath)
        if (!st.isFile()) continue
        // sessionId 从目录名提取：session-<uuid>
        const sessionId = basename(sub).slice('session-'.length)
        files.push({ sessionId, filePath, mtimeMs: st.mtimeMs })
      } catch {
        continue
      }
    }
  }
  return files
}

/** 索引结果统计 */
export interface IndexReport {
  sessionsScanned: number
  sessionsIndexed: number
  sessionsSkipped: number
  recordsWritten: number
  reasoningWritten: number
  vectorsWritten: number
  badFrames: number
  parseErrors: number
  durationMs: number
}

/**
 * 索引一个会话文件：解压 → 提取 → 落库（records + FTS + reasoning + 向量）。
 * 全量索引（不增量过滤），但只在该文件 mtime 晚于上次索引时重扫（由调用方控制）。
 */
export async function indexSession(
  store: MemoryStore,
  vectorStore: VectorStore,
  config: IndexerConfig,
  file: SessionFile,
  report: IndexReport,
): Promise<void> {
  const log = readSessionLog(file.filePath, file.sessionId)
  report.badFrames += log.badFrames
  report.parseErrors += log.parseErrors

  const extracted = extractFromEvents(log.sessionId, log.events)
  report.sessionsIndexed += 1
  report.recordsWritten += extracted.records.length
  report.reasoningWritten += extracted.reasoning.length

  // 统一事件列表：正文事件 + 思考事件都是「事件」，各自占一个会话内编号。
  // shadowed 标记按 (sessionId, seq) 应用。
  const rows: Array<{ event: MemoryRecord; shadowed: boolean }> = [
    ...extracted.records.map(record => ({
      event: record,
      shadowed: extracted.shadowedSeqs.has(record.seq),
    })),
    ...extracted.reasoning.map(event => ({
      event,
      shadowed: extracted.shadowedSeqs.has(event.seq),
    })),
  ]

  // 写库整体包一个事务（8 万+ 事件时逐条自动提交事务是数量级的开销）
  store.transaction(() => {
    store.insertBatch(rows)
    store.setWatermark({
      sessionId: log.sessionId,
      lastSeq: extracted.lastSeq,
      indexedAt: new Date().toISOString(),
      eventCount: extracted.eventCount,
    })
  })

  // 向量通道在事务外（embedding 是网络调用，不该占着写锁）

  // 向量通道（决策①：reasoning 只向量化；records 的 user/assistant/tool-result 也向量化）
  if (!(vectorStore instanceof NoopVectorStore) && config.embedding) {
    const embedMaxChars = config.embedMaxChars ?? 1500
    const seen = new Set<VectorRecordId>()
    for (const record of extracted.records) {
      if (!isVectorWorthy(record)) continue
      const id = vectorIdForRecord(record)
      if (seen.has(id)) continue
      seen.add(id)
      const text = clipForEmbedding(record.text, embedMaxChars)
      try {
        const embedding = await config.embedding.embed(text)
        await vectorStore.upsert(id, embedding)
        report.vectorsWritten += 1
      } catch {
        // embedding 失败不阻断索引（向量是增强不是底座）
      }
    }
    for (const r of extracted.reasoning) {
      const id = vectorIdForReasoning(r)
      if (seen.has(id)) continue
      seen.add(id)
      const text = clipForEmbedding(r.text, embedMaxChars)
      try {
        const embedding = await config.embedding.embed(text)
        await vectorStore.upsert(id, embedding)
        report.vectorsWritten += 1
      } catch {
        // 同上
      }
    }
  }

  // 水位线已在上面的事务里落库；这里只保留接口说明。
  // （向量通道失败不阻断索引——向量是增强不是底座。）
}

/** records 里值得向量化的 kind（tool-call 参数无语义价值，只进 FTS） */
function isVectorWorthy(record: MemoryRecord): boolean {
  return record.kind === 'user' || record.kind === 'assistant' || record.kind === 'tool-result' || record.kind === 'summary'
}

/** 向量 id：'r:<sessionId>:<seq>:<kind>' */
function vectorIdForRecord(record: MemoryRecord): VectorRecordId {
  return `r:${record.sessionId}:${record.seq}:${record.kind}`
}

/** 向量 id：'n:<sessionId>:<seq>'（reasoning） */
function vectorIdForReasoning(record: ReasoningRecord): VectorRecordId {
  return `n:${record.sessionId}:${record.seq}`
}

function clipForEmbedding(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text
}

/** 全量索引入口：扫描目录 → 跳过 mtime 未变的会话 → 逐个索引 */
export async function indexAll(config: IndexerConfig, store?: MemoryStore): Promise<{
  store: MemoryStore
  report: IndexReport
}> {
  const startedAt = Date.now()
  const db = store ?? new MemoryStore({ path: join(config.dataDir, 'memory.sqlite') })
  const vectorStore = config.vectorStore ?? new NoopVectorStore()
  const report: IndexReport = {
    sessionsScanned: 0,
    sessionsIndexed: 0,
    sessionsSkipped: 0,
    recordsWritten: 0,
    reasoningWritten: 0,
    vectorsWritten: 0,
    badFrames: 0,
    parseErrors: 0,
    durationMs: 0,
  }

  const files = discoverSessionFiles(config.sessionsDir)
  report.sessionsScanned = files.length

  for (const file of files) {
    const watermark = db.getWatermark(file.sessionId)
    // 增量：mtime 未变且已有水位线 → 跳过
    if (watermark && watermark.lastSeq >= 0 && watermark.eventCount > 0) {
      // 水位线只反映"上次索引时的事件数"；文件 mtime 更新说明有新事件
      if (file.mtimeMs <= new Date(watermark.indexedAt).getTime()) {
        report.sessionsSkipped += 1
        continue
      }
    }
    await indexSession(db, vectorStore, config, file, report)
  }

  db.setMeta('lastIndexedAt', new Date().toISOString())
  report.durationMs = Date.now() - startedAt
  return { store: db, report }
}
