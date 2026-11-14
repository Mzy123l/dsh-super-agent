// 构建后处理：tsc 不复制非 TS 资源，把 schema.sql 复制进 dist
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(fileURLToPath(import.meta.url)) + '/..'
const dest = join(root, 'dist/store')
mkdirSync(dest, { recursive: true })
copyFileSync(join(root, 'src/store/schema.sql'), join(dest, 'schema.sql'))
console.log('[postbuild] schema.sql -> dist/store/')
