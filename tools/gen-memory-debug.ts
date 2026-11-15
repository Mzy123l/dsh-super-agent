#!/usr/bin/env node
// 生成上下文对比 HTML
//
// **两种模式**：
//
// 1. **同轮双栏**（新格式）：同一轮的「原版上下文」vs「新版上下文」。
//    采集文件里每行带 `phase`（before/after）与 `requestKey`（配对键）。
//    ```bash
//   node dist/gen-memory-debug.js --before <capture.jsonl> --after <capture.jsonl> --out out.html
//   node dist/gen-memory-debug.js --dir <capture-dir> --out out.html   # 自动按 phase 分栏
//   ```
//    同一个文件同时含 before 与 after 行时，只需给它一次。
//
// 2. **A/B 两轮**（旧格式）：不启用插件的一轮 vs 启用插件的一轮，按 `variant` 分组。
//    ```bash
//   node dist/gen-memory-debug.js --on <capture-on.jsonl> --off <capture-off.jsonl> --out out.html
//   ```
//
// 参数：
//   --before <path>      原版上下文一侧的 JSONL（可重复）
//   --after <path>       新版上下文一侧的 JSONL（可重复）
//   --on <path>          启用插件一侧的 JSONL（旧格式，可重复）
//   --off <path>         不启用插件一侧的 JSONL（旧格式，可重复）
//   --dir <path>         目录：自动读出全部 .jsonl，按 phase / variant 字段分流
//   --mode <variant|phase>  强制模式（默认自动探测）
//   --out <path>         输出 HTML（默认 memory-debug.html）
//   --max-chars <n>      单条正文进入页面的字符上限（0 = 不截断，默认 20000）
//   --preview <n>        折叠态每段显示的字符数（默认 220）
//   --max-ops <n>        单个气泡最多渲染的操作条数（默认 200）
//   --title <text>       页面标题
//   --quiet              不打印摘要

import { writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { buildPayload } from './lib/model.js'
import { listJsonlFiles, readJsonlFiles } from './lib/reader.js'
import { formatBytes, renderHtml } from './lib/render.js'
import type { CaptureLine } from './lib/types.js'

interface Args {
  before: string[]
  after: string[]
  on: string[]
  off: string[]
  dir: string[]
  out: string
  maxChars: number
  preview: number
  maxOps: number
  title: string
  mode?: 'variant' | 'phase'
  quiet: boolean
}

/** 解析命令行 */
function parseArgs(argv: string[]): Args {
  const args: Args = {
    before: [],
    after: [],
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
      case '--before':
        if (next !== undefined) args.before.push(next)
        i++
        break
      case '--after':
        if (next !== undefined) args.after.push(next)
        i++
        break
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
      case '--mode':
        if (next === 'variant' || next === 'phase') args.mode = next
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
  console.log(`gen-memory-debug — 上下文对比 HTML 生成器

用法：
  # 同轮双栏（新格式）：原版上下文 vs 新版上下文
  node dist/gen-memory-debug.js --before <capture.jsonl> --after <capture.jsonl> --out out.html
  node dist/gen-memory-debug.js --dir <capture-dir> --out out.html

  # A/B 两轮（旧格式）
  node dist/gen-memory-debug.js --on <capture-on.jsonl> --off <capture-off.jsonl> --out out.html

参数：
  --before <path>    原版上下文一侧的 JSONL（可重复）
  --after <path>     新版上下文一侧的 JSONL（可重复）
  --on <path>        启用插件一侧的 JSONL（旧格式，可重复）
  --off <path>       不启用插件一侧的 JSONL（旧格式，可重复）
  --dir <path>       目录：读出全部 .jsonl，按每行的 phase / variant 字段分流
  --mode <m>         强制模式：variant（A/B 两轮）或 phase（同轮双栏）；默认自动探测
  --out <path>       输出 HTML 路径（默认 memory-debug.html）
  --max-chars <n>    单条正文进入页面的字符上限，0 = 不截断（默认 20000）
  --preview <n>      折叠态每段显示的字符数（默认 220）
  --max-ops <n>      单个气泡最多渲染的操作条数（默认 200）
  --title <text>     页面标题
  --quiet            不打印摘要`)
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))

  if (args.dir.length === 0 && args.before.length === 0 && args.after.length === 0
    && args.on.length === 0 && args.off.length === 0) {
    console.error('至少要给出 --before / --after / --on / --off / --dir 之一。')
    printUsage()
    return 2
  }

  const started = Date.now()
  const warnings: string[] = []
  let lines: CaptureLine[] = []

  // 1. 收集文件（去重：同一个文件被 --before/--after 同时指定时只读一次）
  const files: string[] = []
  const seenFiles = new Set<string>()
  const addFile = (path: string): void => {
    const key = resolve(path)
    if (seenFiles.has(key)) return
    seenFiles.add(key)
    files.push(path)
  }
  for (const dir of args.dir) {
    const found = await listJsonlFiles(dir)
    if (found.length === 0) warnings.push(`目录里没有 .jsonl：${dir}`)
    for (const file of found) addFile(file)
  }
  for (const file of [...args.before, ...args.after, ...args.on, ...args.off]) addFile(file)

  if (files.length === 0) {
    console.error('没有可读的 JSONL 文件。')
    return 2
  }

  // 2. 读取
  const load = await readJsonlFiles(files)
  lines = load.lines
  warnings.push(...load.warnings)

  if (lines.length === 0) {
    console.error('读到的行数为 0，无法生成。')
    for (const w of warnings.slice(0, 10)) console.error(`  ${w}`)
    return 1
  }

  // 3. 统计 phase / variant 分布
  const byPhase = new Map<string, number>()
  const byVariant = new Map<string, number>()
  for (const line of lines) {
    byPhase.set(line.phase, (byPhase.get(line.phase) ?? 0) + 1)
    byVariant.set(line.variant, (byVariant.get(line.variant) ?? 0) + 1)
  }

  // 4. 构建载荷（模式自动探测：出现 before 行 → phase 模式）
  const payload = buildPayload(lines, {
    maxChars: args.maxChars,
    maxOps: args.maxOps,
    previewChars: args.preview,
    title: args.title,
    ...args.mode === undefined ? {} : { mode: args.mode },
  })
  payload.meta.warnings = warnings
  payload.meta.buildMs = Date.now() - started

  // 5. 渲染
  const html = renderHtml(payload)
  const outPath = resolve(args.out)
  await writeFile(outPath, html, 'utf8')

  if (!args.quiet) {
    const s = payload.summary
    console.log(`已生成：${outPath}`)
    console.log(`  文件大小   : ${formatBytes(Buffer.byteLength(html, 'utf8'))}`)
    console.log(`  读入行数   : ${load.rawLines}（有效 ${lines.length}）`)
    console.log(`  模式       : ${s.mode === 'phase' ? '同轮双栏（before vs after）' : 'A/B 两轮（variant）'}`)
    console.log(`  phase 分布 : ${[...byPhase.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
    console.log(`  variant 分布: ${[...byVariant.entries()].map(([k, v]) => `${k}=${v}`).join(' ')}`)
    console.log(`  会话对数   : ${payload.pairs.length}`)
    console.log(`  气泡总数   : ${payload.meta.totalSteps}`)
    if (s.mode === 'phase') {
      console.log(`  原版最终   : ${s.offFinal[0]} 条 / ${s.offFinal[1]} 字符 / reasoning ${s.offFinal[2]}`)
      console.log(`  新版最终   : ${s.onFinal[0]} 条 / ${s.onFinal[1]} 字符 / reasoning ${s.onFinal[2]}`)
      console.log(`  累计注入   : ${s.savedChars >= 0 ? '+' : ''}${s.savedChars} 字符 / ${s.savedMessages >= 0 ? '+' : ''}${s.savedMessages} 条`)
    } else {
      console.log(`  左侧最终   : ${s.offFinal[0]} 条 / ${s.offFinal[1]} 字符 / reasoning ${s.offFinal[2]}`)
      console.log(`  右侧最终   : ${s.onFinal[0]} 条 / ${s.onFinal[1]} 字符 / reasoning ${s.onFinal[2]}`)
      console.log(`  累计节省   : ${s.savedChars} 字符 / ${s.savedMessages} 条`)
    }
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
