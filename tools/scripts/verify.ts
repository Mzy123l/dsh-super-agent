// 无头浏览器验证：用 Edge/Chrome 的 CDP 端口 + 纯 Node 内置模块驱动
//
// 目的：子代理会话拿不到 DSH 共享浏览器的 sidebar（没有 conversation id），
// 这里自己起一个无头实例，做真实渲染验证：
//   - 打开页面 → 收集 console / pageerror
//   - 截图（首屏 + 全页）
//   - 读取 DOM 关键结构做断言（左右气泡数量、对齐、高亮、折叠状态）
//
// 用法：node dist/scripts/verify.js <url> <outDir>
//
// 零运行时依赖：直接说 CDP 的 WebSocket 协议（Node 22 有全局 WebSocket）。

import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

async function findBrowser(): Promise<string | null> {
  const { access } = await import('node:fs/promises')
  for (const p of EDGE_CANDIDATES) {
    try {
      await access(p)
      return p
    } catch {
      /* 继续找 */
    }
  }
  return null
}

/** 极简 CDP 客户端 */
class Cdp {
  private ws: WebSocket
  private id = 0
  private pending = new Map<number, (v: unknown) => void>()
  readonly events: Array<{ method: string; params: Record<string, unknown> }> = []

  constructor(ws: WebSocket) {
    this.ws = ws
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number
        result?: unknown
        method?: string
        params?: Record<string, unknown>
      }
      if (typeof msg.id === 'number') {
        const resolve = this.pending.get(msg.id)
        if (resolve) {
          this.pending.delete(msg.id)
          resolve(msg.result)
        }
      } else if (msg.method) {
        this.events.push({ method: msg.method, params: msg.params ?? {} })
      }
    })
  }

  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url)
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve())
      ws.addEventListener('error', (e) => reject(new Error(`ws error: ${String(e)}`)))
      setTimeout(() => reject(new Error('ws 连接超时')), 15000)
    })
    return new Cdp(ws)
  }

  send(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const id = ++this.id
    return new Promise((resolve) => {
      this.pending.set(id, resolve)
      this.ws.send(JSON.stringify({ id, method, params }))
    })
  }

  /** 求值并返回 JSON 化的结果 */
  async eval<T>(expression: string): Promise<T> {
    const res = (await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
    })) as { result?: { value?: T }; exceptionDetails?: { text?: string } } | undefined
    if (!res) throw new Error('Runtime.evaluate 没有返回结果')
    if (res.exceptionDetails) throw new Error(res.exceptionDetails.text)
    return res.result?.value as T
  }

  close(): void {
    this.ws.close()
  }
}

async function waitForEndpoint(port: number, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) {
        const info = (await res.json()) as { webSocketDebuggerUrl: string }
        return info.webSocketDebuggerUrl
      }
    } catch {
      /* 还没起来 */
    }
    await delay(250)
  }
  throw new Error(`CDP 端口 ${port} 超时未就绪`)
}

/** 等待并返回一个「页面」target 的 WebSocket 地址 */
async function waitForPageTarget(port: number, timeoutMs = 20000): Promise<string> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`)
      if (res.ok) {
        const targets = (await res.json()) as Array<{
          type: string
          url: string
          webSocketDebuggerUrl?: string
        }>
        const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
        if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl
      }
    } catch {
      /* 还没起来 */
    }
    await delay(250)
  }
  throw new Error(`CDP 端口 ${port} 上没找到页面 target`)
}

async function main(): Promise<void> {
  const url = process.argv[2] ?? 'http://127.0.0.1:8731/memory-debug.html'
  const outDir = resolve(process.argv[3] ?? '.tmp/verify')
  await mkdir(outDir, { recursive: true })

  const bin = await findBrowser()
  if (!bin) {
    console.error('找不到 Edge/Chrome 可执行文件')
    process.exitCode = 2
    return
  }
  const port = 9333
  const userDataDir = join(outDir, 'profile')
  await mkdir(userDataDir, { recursive: true })
  // Windows 沙箱下 Node 的 spawn 无法可靠拉起 GUI 进程（管道被禁），
  // 改用 PowerShell Start-Process（-WindowStyle Hidden 避免弹窗）。
  // 注意：PowerShell 参数用单引号包裹，避免 JSON 双引号被 PowerShell 解析成转义符。
  const { execFile } = await import('node:child_process')
  const psQuote = (s: string): string => `'${s.replace(/'/g, "''")}'`
  const browserArgs = [
    '--headless=new',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1600,1100',
    url,
  ]
  const psArgs = [
    '-NoProfile',
    '-Command',
    `$p = Start-Process -FilePath ${psQuote(bin)} -ArgumentList ${browserArgs.map(psQuote).join(',')} -PassThru -WindowStyle Hidden; Write-Output $p.Id`,
  ]
  const pidText = await new Promise<string>((resolve, reject) => {
    execFile('powershell.exe', psArgs, { encoding: 'utf8' }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout.trim())
    })
  })
  const procPid = Number(pidText.split(/\s+/).pop() ?? '0')

  let cdp: Cdp
  try {
    // 连到「页面」target，而不是 browser target：
    // browser target 上没有 Runtime/Page 域，evaluate 会失败。
    const pageWsUrl = await waitForPageTarget(port)
    cdp = await Cdp.connect(pageWsUrl)

    await cdp.send('Runtime.enable')
    await cdp.send('Log.enable')
    await cdp.send('Page.enable')

    // 目标页可能还是 about:blank（Edge 启动竞态），确保导航到目标 URL
    const currentUrl = await cdp.eval<string>('location.href')
    if (!currentUrl.includes('memory-debug')) {
      await cdp.send('Page.navigate', { url })
      await delay(2000)
    }

    // 等页面加载完
    await delay(2500)

    // ── 收集 console / 异常 ──
    const consoleLines: string[] = []
    const pageErrors: string[] = []
    for (const ev of cdp.events) {
      if (ev.method === 'Runtime.consoleAPICalled') {
        const type = String((ev.params as { type?: string }).type ?? '')
        const args = (ev.params as { args?: Array<{ value?: unknown; description?: string }> }).args ?? []
        const text = args
          .map((a) => (a.value !== undefined ? String(a.value) : (a.description ?? '')))
          .join(' ')
        consoleLines.push(`[${type}] ${text}`)
      } else if (ev.method === 'Runtime.exceptionThrown') {
        const d = (ev.params as { exceptionDetails?: { text?: string; exception?: { description?: string } } })
          .exceptionDetails
        pageErrors.push(d?.exception?.description ?? d?.text ?? '未知异常')
      } else if (ev.method === 'Log.entryAdded') {
        const e = ev.params as { entry?: { level?: string; text?: string } }
        if (e.entry && (e.entry.level === 'error' || e.entry.level === 'warning')) {
          consoleLines.push(`[${e.entry.level}] ${e.entry.text ?? ''}`)
        }
      }
    }

    // ── 结构断言 ──
    const probe = await cdp.eval<Record<string, unknown>>(`(() => {
      var rows = document.querySelectorAll('.row');
      var offBubbles = document.querySelectorAll('.cell--off .bubble');
      var onBubbles = document.querySelectorAll('.cell--on .bubble');
      var visibleRows = 0;
      rows.forEach(function(r){ if(!r.classList.contains('hidden')) visibleRows++; });
      var ops = document.querySelectorAll('.op');
      var kinds = {};
      ops.forEach(function(o){ var k=o.getAttribute('data-kind'); kinds[k]=(kinds[k]||0)+1; });
      // 左右对齐：同一行内左右气泡的顶部差
      var maxAlign = 0, aligned = 0, checked = 0;
      rows.forEach(function(r){
        var a = r.querySelector('.cell--off .bubble');
        var b = r.querySelector('.cell--on .bubble');
        if(!a || !b) return;
        checked++;
        var d = Math.abs(a.getBoundingClientRect().top - b.getBoundingClientRect().top);
        if (d < 1.5) aligned++;
        if (d > maxAlign) maxAlign = d;
      });
      var overflow = document.documentElement.scrollWidth > window.innerWidth + 2;
      var tableRows = document.querySelectorAll('.summary tbody tr').length;
      var externals = Array.prototype.map.call(
        document.querySelectorAll('script[src], link[href]:not([href^="data:"]), img[src], iframe[src]'),
        function(el){ return el.getAttribute('src') || el.getAttribute('href'); }
      );
      return {
        title: document.title,
        rows: rows.length,
        visibleRows: visibleRows,
        offBubbles: offBubbles.length,
        onBubbles: onBubbles.length,
        ops: ops.length,
        opKinds: kinds,
        alignedCount: aligned,
        checkedCount: checked,
        maxAlignDelta: maxAlign,
        horizontalOverflow: overflow,
        tableRows: tableRows,
        externals: externals,
        payloadLoaded: typeof window.__PAYLOAD__ !== 'undefined',
        statOff: (document.querySelector('#stat-off [data-f="ord"]')||{}).textContent,
        statOn: (document.querySelector('#stat-on [data-f="ord"]')||{}).textContent,
        docHeight: document.documentElement.scrollHeight,
        bodyBg: getComputedStyle(document.body).backgroundColor
      };
    })()`)

    // ── 截图：首屏 ──
    const shot1 = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    await writeFile(join(outDir, 'viewport.png'), Buffer.from(shot1.data, 'base64'))

    // ── 截图：全页 ──
    const metrics = (await cdp.send('Page.getLayoutMetrics')) as {
      cssContentSize?: { width: number; height: number }
    }
    const fullHeight = Math.min(metrics.cssContentSize?.height ?? 2000, 12000)
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1600,
      height: Math.max(fullHeight, 1100),
      deviceScaleFactor: 1,
      mobile: false,
    })
    await delay(600)
    const shot2 = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    await writeFile(join(outDir, 'fullpage.png'), Buffer.from(shot2.data, 'base64'))
    await cdp.send('Emulation.clearDeviceMetricsOverride')

    // ── 交互验证：切到「全量」 ──
    await cdp.eval(`(function(){
      var seg = document.getElementById('mode-seg');
      var btns = seg.querySelectorAll('button');
      btns[1].click();
      return true;
    })()`)
    await delay(400)
    const allMode = await cdp.eval<Record<string, unknown>>(`(() => {
      var hidden = document.querySelectorAll('.row.hidden').length;
      return { hiddenRows: hidden, totalRows: document.querySelectorAll('.row').length };
    })()`)
    const shot3 = (await cdp.send('Page.captureScreenshot', { format: 'png' })) as { data: string }
    await writeFile(join(outDir, 'allmode.png'), Buffer.from(shot3.data, 'base64'))

    // ── 交互验证：展开一条正文 ──
    const expanded = await cdp.eval<Record<string, unknown>>(`(() => {
      var more = document.querySelector('.op .more');
      if (!more) {
        // 没有超过预览长度的正文时，直接检查未变块的展开
        var exp = document.querySelector('.unchanged .expand');
        if (!exp) return { found: false, reason: 'no more/expand elements' };
        exp.click();
        var box = exp.closest('.unchanged');
        return { found: true, kind: 'unchanged', opened: box.classList.contains('open') };
      }
      more.click();
      var txt = more.parentNode.querySelector('.txt');
      return { found: true, kind: 'text', hasFull: txt.classList.contains('full'), label: more.textContent };
    })()`)

    // 切回只看差异
    await cdp.eval(`(function(){
      var seg = document.getElementById('mode-seg');
      seg.querySelectorAll('button')[0].click();
      return true;
    })()`)
    await delay(300)

    const report = {
      url,
      browser: bin,
      console: consoleLines,
      pageErrors,
      probe,
      allMode,
      expanded,
    }
    await writeFile(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
    console.log(JSON.stringify(report, null, 2))

    cdp.close()
  } finally {
    // 收尾：taskkill 整个进程树
    if (procPid > 0) {
      const { execFile } = await import('node:child_process')
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(procPid), '/T', '/F'], { encoding: 'utf8' }, () => resolve())
      })
    }
  }
}

main().catch((err: unknown) => {
  console.error('验证失败：', err)
  process.exitCode = 1
})
