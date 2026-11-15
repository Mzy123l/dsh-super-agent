#!/bin/bash
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

echo "=== dsh 的模块解析起点是 profile node_modules ==="
echo "--- 从 profile 目录解析插件 ---"
cd "$HOME/.dsh/profiles/web" || exit 1
node -e "
import('dsh-memory-plugin')
  .then(m => console.log('从 profile 解析 OK:', Object.keys(m).join(', ')))
  .catch(e => {
    console.error('从 profile 解析 FAILED:', e.message)
    console.error(e.stack?.split('\n').slice(0,8).join('\n'))
  })
" 2>&1 | head -16

echo ""
echo "--- 从 profile 解析 dsh-llm ---"
node -e "
import('@deepseek-ai/dsh-llm')
  .then(m => console.log('dsh-llm OK'))
  .catch(e => console.error('dsh-llm FAIL:', e.message))
" 2>&1 | head -6

echo ""
echo "--- 从 profile 解析 dsh-tools ---"
node -e "
import('@deepseek-ai/dsh-tools')
  .then(m => console.log('dsh-tools OK'))
  .catch(e => console.error('dsh-tools FAIL:', e.message))
" 2>&1 | head -6
exit 0
