#!/bin/bash
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
echo "=== import index.js（dsh 的 main 入口）==="
node -e "
import('./dist/index.js')
  .then(m => console.log('index.js OK'))
  .catch(e => { console.error('index.js FAILED:', e.message); console.error(e.stack?.split('\n').slice(0,8).join('\n')) })
" 2>&1 | head -14

echo ""
echo "=== cordis.patch.yml 内容 ==="
cat cordis.patch.yml 2>/dev/null || echo "（文件不存在）"

echo ""
echo "=== profile 里的 patch 记录 ==="
grep -r "memory" "$HOME/.dsh/profiles/web/cordis.patch.yml" 2>/dev/null || echo "（profile patch 中无 memory 记录）"
exit 0
