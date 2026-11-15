#!/bin/bash
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

echo "=== 用 cordis 真实激活插件，抓 apply 抛的错 ==="
node --input-type=module -e "
import { Context } from '@deepseek-ai/cordis'
import * as plugin from './dist/index.js'

const ctx = new Context()
// 提供 tools 服务，模拟 dsh 环境
ctx.provide('tools', { register: (t) => console.log('[mock] tool registered:', t?.name ?? '(unnamed)') })

try {
  plugin.apply(ctx)
  console.log('apply OK')
} catch (e) {
  console.error('apply FAILED:', e.message)
  console.error(e.stack?.split('\n').slice(0, 8).join('\n'))
}
setTimeout(() => process.exit(0), 300)
" 2>&1 | head -25
exit 0
