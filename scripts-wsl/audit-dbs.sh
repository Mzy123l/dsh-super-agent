#!/bin/bash
# 核实：所有 memory.sqlite 的位置、大小、schema 新旧、测试数量
set -u
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== 1. 全盘找 memory.sqlite ==="
find "$HOME" -name 'memory.sqlite' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  sz=$(stat -c%s "$f" 2>/dev/null)
  echo "  $f  (${sz} 字节, $(( sz / 1024 )) KB)"
  node -e "
const D=require('$HOME/dsh-plugins/memory-plugin/node_modules/better-sqlite3');
try{const db=new D('$f',{readonly:true});
const t=db.prepare(\"SELECT name FROM sqlite_master WHERE type='table'\").all().map(r=>r.name);
const hasNew=t.includes('message')&&t.includes('plan')&&t.includes('fold');
const hasOld=t.includes('event')||t.includes('records');
let n='-'; try{n=db.prepare('SELECT COUNT(*) AS n FROM message').get().n}catch{}
console.log('    表数='+t.length+' 新表='+hasNew+' 旧表='+hasOld+' message行数='+n);
if(hasOld){try{console.log('    (旧) event行数='+db.prepare('SELECT COUNT(*) AS n FROM event').get().n)}catch{}}
db.close()}catch(e){console.log('    打不开: '+e.message)}
" 2>&1 | head -4
done

echo ""
echo "=== 2. 数据目录由什么决定（默认配置）==="
grep -n "dataDir" "$HOME/dsh-plugins/memory-plugin/src/dsh-bundle.ts" | head -5

echo ""
echo "=== 3. 测试数量 ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
if [ -d node_modules ]; then
  npx vitest run --reporter=basic 2>&1 | tail -6
else
  echo "（无 node_modules）"
fi
exit 0
