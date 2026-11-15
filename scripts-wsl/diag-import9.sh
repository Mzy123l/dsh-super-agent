#!/bin/bash
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

echo "=== WSL 侧 dist 实际内容 ==="
ls dist/*.js 2>/dev/null || echo "（dist 为空！）"

echo ""
echo "=== package.json main ==="
node -e "const p=require('./package.json'); console.log('main:', p.main, '| type:', p.type)"

echo ""
echo "=== dist/index.js 是否存在 ==="
ls -la dist/index.js 2>/dev/null || echo "（不存在！）"

echo ""
echo "=== 直接导入 dist/index.js ==="
node -e "
import('./dist/index.js')
  .then(m => console.log('OK:', Object.keys(m).length, 'exports'))
  .catch(e => { console.error('FAIL:', e.message); console.error(e.stack?.split('\n').slice(0,6).join('\n')) })
" 2>&1 | head -12

echo ""
echo "=== schema.sql 位置 ==="
ls dist/store/schema.sql 2>/dev/null || echo "（缺 schema.sql）"
exit 0
