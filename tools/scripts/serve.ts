// 临时静态服务器：仅用于浏览器验证生成的 HTML
// 用法：node dist/scripts/serve.js <dir> <port>
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname, join, normalize, resolve } from 'node:path'

const dir = resolve(process.argv[2] ?? '.')
const port = Number(process.argv[3] ?? 8731)

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jsonl': 'text/plain; charset=utf-8',
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? '/', 'http://localhost')
    let path = decodeURIComponent(url.pathname)
    if (path === '/' || path === '') path = '/memory-debug.html'
    const full = join(dir, normalize(path).replace(/^([/\\])+/, ''))
    if (!full.startsWith(dir)) {
      res.writeHead(403).end('forbidden')
      return
    }
    const info = await stat(full)
    if (!info.isFile()) {
      res.writeHead(404).end('not found')
      return
    }
    res.writeHead(200, {
      'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream',
      'Content-Length': info.size,
      'Cache-Control': 'no-store',
    })
    createReadStream(full).pipe(res)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${dir} at http://127.0.0.1:${port}/`)
})
