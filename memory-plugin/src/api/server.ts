// HTTP 只读 API（规格 §5.1）：为 Router / 面板预留。
//
// 只读 + 一个 POST（触发增量索引）。无鉴权 = 只监听 127.0.0.1（DESIGN.md 说明）。
// 决策④：这里的 POST /index 是显式调用，不是自动触发；插件自身无任何主动注入逻辑。

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { MemoryStore } from '../store/sqlite.js'
import { indexAll } from '../ingest/indexer.js'
import { search, searchReasoning } from '../search/index.js'
import { NoopVectorStore } from '../search/vector.js'
import type { IndexerConfig, VectorStore } from '../types.js'

export interface ApiServerOptions {
  store: MemoryStore
  config: IndexerConfig
  vectorStore?: VectorStore
  embedding?: import('../search/vector.js').OpenAICompatEmbedding
  port?: number
  host?: string
}

/** 只读 API 服务。默认 127.0.0.1:7800。 */
export function startApiServer(options: ApiServerOptions): Server {
  const port = options.port ?? 7800
  const host = options.host ?? '127.0.0.1'
  const vectorStore = options.vectorStore ?? new NoopVectorStore()

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      await handle(options.store, options.config, vectorStore, options.embedding, req, res)
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ error: String(error) }))
    }
  })
  server.listen(port, host)
  return server
}

async function handle(
  store: MemoryStore,
  config: IndexerConfig,
  vectorStore: VectorStore,
  embedding: import('../search/vector.js').OpenAICompatEmbedding | undefined,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname
  const params = url.searchParams

  const json = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  if (req.method !== 'GET' && req.method !== 'POST') {
    json(405, { error: 'method not allowed' })
    return
  }

  // GET /records?sessionId=&kind=&q=&shadowed=&limit=&offset=
  if (path === '/records' && req.method === 'GET') {
    const shadowedParam = params.get('shadowed')
    const records = store.listRecords({
      sessionId: params.get('sessionId') ?? undefined,
      kind: params.get('kind') ?? undefined,
      q: params.get('q') ?? undefined,
      shadowed: shadowedParam === null ? undefined : shadowedParam === 'true',
      limit: Number(params.get('limit') ?? 50),
      offset: Number(params.get('offset') ?? 0),
    })
    json(200, { records })
    return
  }

  // GET /search?q=&mode=keyword|hybrid&limit=
  if (path === '/search' && req.method === 'GET') {
    const q = params.get('q')
    if (!q) {
      json(400, { error: 'missing q' })
      return
    }
    const mode = params.get('mode') === 'hybrid' ? 'hybrid' : 'keyword'
    const limit = Number(params.get('limit') ?? 20)
    const results = await search(
      { store, vectorStore, embedding },
      q,
      { mode, limit },
    )
    json(200, { results })
    return
  }

  // GET /reasoning?sessionId=&q=
  if (path === '/reasoning' && req.method === 'GET') {
    const sessionId = params.get('sessionId') ?? undefined
    const q = params.get('q')
    if (q) {
      const hits = await searchReasoning({ store, vectorStore, embedding }, q, {
        limit: Number(params.get('limit') ?? 20),
      })
      const filtered = sessionId
        ? hits.filter((hit) => hit.sessionId === sessionId)
        : hits
      json(200, { hits: filtered })
      return
    }
    json(200, { records: store.listReasoning(sessionId, Number(params.get('limit') ?? 100)) })
    return
  }

  // GET /status
  if (path === '/status' && req.method === 'GET') {
    json(200, store.status(vectorStore.count()))
    return
  }

  // POST /index：触发增量索引（显式调用，非自动）
  if (path === '/index' && req.method === 'POST') {
    const { report } = await indexAll(config, store)
    json(200, report)
    return
  }

  json(404, { error: 'not found' })
}
