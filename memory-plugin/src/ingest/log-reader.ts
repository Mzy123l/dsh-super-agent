// 逐帧解压 .jsonl.zstd（拼接 zstd 帧容器，magic 0xFD2FB528）→ 事件流
//
// 复用 96/9I/98 已验证的口径：DSH 会话日志不是单个 zstd 流，而是每次追加写一帧、
// 帧首尾相接的容器。正确做法是逐帧扫边界后对每帧单独解压。
// 会话文件被实时写入：最后一帧可能残缺（torn frame），try/catch 跳过即可。

import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'
import type { RawEvent, SessionLog } from './raw-types.js'

/** zstd 帧魔数（小端 0xFD2FB528） */
const ZSTD_MAGIC = 0xfd2fb528

/** 一个完整 zstd 帧在文件中的字节区间 [start, end) */
interface FrameRange {
  start: number
  end: number
}

/** 扫描结果：完整帧区间 + 残帧起点（若 EOF 打断了最后一帧） */
interface FrameScan {
  frames: FrameRange[]
  tornStart?: number
}

/**
 * 结构性扫描拼接 zstd 流：按帧头/块头逐字节推进，定位每个完整帧的边界。
 * 不解压块内容，只做边界识别。坏结构（魔数错、保留位非零）抛错由调用方容错。
 */
export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): FrameScan {
  const frames: FrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    // 魔数 4 字节
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4

    // 帧头描述符 1 字节
    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0
      ? (singleSegment ? 1 : 0)
      : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    // 逐块扫块头（3 字节 little-endian），直到 last-block
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`reserved block type at byte ${offset - 3}`)
      }
      // RLE 块只占 1 字节负载
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    // 帧尾校验和 4 字节
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/**
 * 读取一个会话日志文件：逐帧解压、拼接明文、按行解析 JSON 事件。
 * 实时写入的文件最后一帧可能残缺——坏帧/残帧/坏行全部跳过并计数，绝不抛出。
 */
export function readSessionLog(filePath: string, sessionId: string): SessionLog {
  const buffer = readFileSync(filePath)
  let frames: FrameRange[] = []
  let badFrames = 0

  try {
    const scan = scanZstdFrames(buffer)
    frames = scan.frames
  } catch {
    // 结构性损坏（罕见）：整文件按 0 帧处理
    return { sessionId, filePath, events: [], frameCount: 0, badFrames: 1, parseErrors: 0 }
  }

  const chunks: string[] = []
  for (const { start, end } of frames) {
    try {
      chunks.push(zstdDecompressSync(buffer.subarray(start, end)).toString('utf8'))
    } catch {
      // 单帧校验失败：跳过该帧（实时写入场景）
      badFrames += 1
    }
  }

  // 帧间可能缺换行，统一补一个分隔符再按行切
  const text = chunks.join('\n')
  const events: RawEvent[] = []
  let parseErrors = 0
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      events.push(JSON.parse(trimmed) as RawEvent)
    } catch {
      parseErrors += 1
    }
  }

  return { sessionId, filePath, events, frameCount: frames.length, badFrames, parseErrors }
}
