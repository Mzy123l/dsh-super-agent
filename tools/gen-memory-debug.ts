#!/usr/bin/env node
// 生成「启用插件 / 不启用插件」的上下文增量对比 HTML
//
// 用法：
//   node dist/gen-memory-debug.js --on <capture-on.jsonl> --off <capture-off.jsonl> --out memory-debug.html
//   node dist/gen-memory-debug.js --dir <capture-dir> --out memory-debug.html
//   node dist/gen-memory-debug.js --on a.jsonl --on b.jsonl --off c.jsonl --out out.html
//
// 参数：
//   --on <path>        启用插件一侧的 JSONL（可重复）
//   --off <path>       不启用插件一侧的 JSONL（可重复）
//   --dir <path>       目录：自动读出全部 .jsonl，按 variant 字段分流
//   --out <path>       输出 HTML（默认 memory-debug.html）
//   --max-chars <n>    单条正文进入页面的字符上限（0 = 不截断，默认 20000）
//   --preview <n>      折叠态每段显示的字符数（默认 220）
//   --max-ops <n>      单个气泡最多渲染的操作条数（默认 200）
//   --title <text>     页面标题
//   --quiet            不打印摘要

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildPayload } from './lib/model.js'
import { listJsonlFiles, readJsonlFiles } from './lib/reader.js'
import { formatBytes, renderHtml } from './lib/render.js'
import type { CaptureLine } from './lib/types.js'

interface Args {
  on: string[]
  off: string[]
  dir: string[]
  out: string
  maxChars: number
  preview: number
  maxOps: number
  title: string
  quiet: boolean
}

/** 解析命令行 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    on: [],
    off: [],
    dir: [],
    out: 'memory-debug.html',
    maxChars: 20000,
    preview: 220,
    maxOps: 200,
    title: '上下文增量对比：不启用插件 vs 启用插件',
    quiet: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const next = argv[i + 1]
    switch (arg) {
      case '--on':
        if (next !== undefined) args.on.push(next)
        i++
        break
      case '--off':
        if (next !== undefined) args.off.push(next)
        i++
        break
      case '--dir':
        if (next !== undefined) args.dir.push(next)
        i++
        break
      case '--out':
        if (next !== undefined) args.out = next
        i++
        break
      case '--max-chars':
        args.maxChars = Number.parseInt(next ?? '0', 10) || 0
        i++
        break
      case '--preview':
        args.preview = Number.parseInt(next ?? '220', 10) || 220
        i++
        break
      case '--max-ops':
        args.maxOps = Number.parseInt(next ?? '200', 10) || 200
        i++
        break
      case '--title':
        if (next !== undefined) args.title = next
        i++
        break
      case '--quiet':
        args.quiet = true
        break
      case '--help':
      case '-h':
        printUsage()
        process.exit(0)
        break
      default:
        if (arg.startsWith('--')) {
          console.error(`未知参数：${arg}`)
          printUsage()
          process.exit(2)
        }
    }
  }
  return args
}

function printUsage(): void {
  console.log(`gen-memory-debug — 上下文增量对比 HTML 生成器

用法：
  node dist/gen-memory-debug.js --on <capture-on.jsonl> --off <capture-off.jsonl> --out memory-debug.html
  node dist/gen-memory-debug.js --dir <capture-dir> --out memory-debug.html

参数：
  --on <path>      启用插件一侧的 JSONL（可重复）
  --off <path>     不启用插件一侧的 JSONL（可重复）
  --dir <path>     目录：读出全部 .jsonl，按每行的 variant 字段分流
  --out <path>     输出 HTML 路径（默认 memory-debug.html）
  --max-chars <n>  单条正文进入页面的字符上限，0 = 不截断（默认 20000）
  --preview <n>    折叠态每段显示的字符数（默认 220）
  --max-ops <n>    单个气泡最多渲染的操作条数（默认 200）
  --title <text>   页面标题
  --quiet          不打印摘要`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.dir.length === 0 && args.on.length === 0 && args.off.length === 0) {
    console.error('至少要给出 --on / --off / --dir 之一。')
    printUsage()
    return 2
  }

  const started = Date.now()
  const warnings: string[] = []
  let lines: CaptureLine[] = []

  // 1. 收集文件
  const files: string[] = []
  for (const dir of args.dir) {
    const found = await listJsonlFiles(dir)
    if (found.length === 0) warnings.push(`目录里没有 .jsonl：${dir}`)
    files.push(...found)
  }
  files.push(...args.on, ...args.off)

  if (files.length === 0) {
    console.error('没有可读的 JSONL 文件。')
    return 2
  }

  // 2. 读取
  const load = await readJsonlFiles(files)
  lines = load.lines
  warnings.push(...load.warnings)

  // 3. 按 variant 分流：--on/--off 指定的文件优先按参数归类；
  //    目录模式下按行内 variant 字段归类。
  if (args.dir.length > 0 && (args.on.length > 0 || args.off.length > 0)) {
    // 混合模式：先按参数给 --on/--off 的文件打标，再按 variant 字段处理其余
    const explicit = new Set([...args.on, ...args.off].map((f) => resolve(f)))
    const tagged: CaptureLine[] = []
    for (const line of load.lines) {
      tagged.push(line)
    }
    // --on / --off 的文件已经带 variant 字段（capture-builder 会写），
    // 这里按 variant 分流即可；参数只用于确认文件存在。
    void explicit
    lines = tagged
  }

  if (lines.length === 0) {
    console.error('读到的行数为 0，无法生成。')
    for (const w of warnings.slice(0, 10)) console.error(`  ${w}`)
    return 1
  }

  // 4. 统计 variant 分布
  const byVariant = new Map<string, number>()
  for (const line of lines) {
    byVariant.set(line.variant, (byVariant.get(line.variant) ?? 0) + 1)
  }

  // 5. 构建载荷
  const payload = buildPayload(lines, {
    maxChars: args.maxChars,
    maxOps: args.maxOps,
    previewChars: args.preview,
    title: args.title,
  })
  payload.meta.warnings = warnings
  payload.meta.buildMs = Date.now() - started

  // 6. 渲染
  const html = renderHtml(payload)
  const outPath = resolve(args.out)
  await writeFile(outPath, html, 'utf8')

  if (!args.quiet) {
    const s = payload.summary
    console.log(`已生成：${outPath}`)
    console.log(`  文件大小   : ${formatBytes(Buffer.byteLength(html, 'utf8'))}`)
    console.log(`  读入行数   : ${load.rawLines}（有效 ${lines.length}）`)
    console.log(`  variant 分布: ${[...byVariant.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
    console.log(`  会话对数   : ${payload.pairs.length}`)
    console.log(`  气泡总数   : ${payload.meta.totalSteps}`)
    console.log(`  左侧最终   : ${s.offFinal[0]} 条 / ${s.offFinal[1]} 字符 / reasoning ${s.offFinal[2]}`)
    console.log(`  右侧最终   : ${s.onFinal[0]} 条 / ${s.onFinal[1]} 字符 / reasoning ${s.onFinal[2]}`)
    console.log(`  累计节省   : ${s.savedChars} 字符 / ${s.savedMessages} 条`)
    console.log(`  构建耗时   : ${payload.meta.buildMs} ms`)
    if (warnings.length > 0) {
      console.log(`  告警       : ${warnings.length} 条（已写进页面）`)
    }
  }
  return 0
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((err: unknown) => {
    console.error('生成失败：', err)
    process.exitCode = 1
  })
