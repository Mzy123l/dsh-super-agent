#!/bin/bash
# 诊断插件导入失败的具体原因
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

echo "=== 直接 import 看真实错误 ==="
node -e "
import('./dist/dsh-bundle.js')
  .then(m => console.log('OK, exports:', Object.keys(m).join(', ')))
  .catch(e => { console.error('IMPORT FAILED:'); console.error(e.message); console.error(e.stack?.split('\n').slice(0,6).join('\n')) })
" 2>&1 | head -20

echo ""
echo "=== 检查 dsh-llm 是否可解析 ==="
node -e "import('@deepseek-ai/dsh-llm').then(m=>console.log('dsh-llm OK, 有 createUserMessage:', typeof m.createUserMessage)).catch(e=>console.error('dsh-llm FAIL:', e.message))" 2>&1 | head -5

echo ""
echo "=== 检查 dsh-tools ==="
node -e "import('@deepseek-ai/dsh-tools').then(m=>console.log('dsh-tools OK, 有 defineTool:', typeof m.defineTool)).catch(e=>console.error('dsh-tools FAIL:', e.message))" 2>&1 | head -5

echo ""
echo "=== package.json 的 dsh 字段 ==="
node -e "const p=require('./package.json'); console.log(JSON.stringify({name:p.name,main:p.main,type:p.type,dsh:p.dsh,peer:p.peerDependencies},null,2))" 2>&1 | head -20
exit 0
