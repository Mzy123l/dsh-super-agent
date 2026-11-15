#!/bin/bash
# 检查插件库里到底有没有本会话的数据，以及单位编号是否正确
set -u
export PATH="$HOME/.npm-global/bin:$PATH"
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

for db in "$HOME/data/memory.sqlite" "$HOME/dsh-plugins/memory-plugin/data/memory.sqlite"; do
  if [ ! -f "$db" ]; then continue; fi
  echo "=========================================="
  echo "库: $db  ($(stat -c%s "$db") 字节)"
  echo "=========================================="
  node -e "
const Database = require('better-sqlite3');
const db = new Database('$db', { readonly: true });
try {
  const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all().map(r=>r.name);
  console.log('表:', tables.join(', '));

  if (tables.includes('message')) {
    const n = db.prepare('SELECT COUNT(*) AS n FROM message').get();
    console.log('message 行数:', n.n);
    const sessions = db.prepare('SELECT sessionId, COUNT(*) AS c, MIN(idx) AS lo, MAX(idx) AS hi FROM message GROUP BY sessionId ORDER BY c DESC LIMIT 5').all();
    console.log('会话分布:');
    for (const s of sessions) console.log('  ' + s.sessionId + ' → ' + s.c + ' 条, 编号 ' + s.lo + '–' + s.hi);
    const sample = db.prepare('SELECT idx, kind, substr(content,1,50) AS t, substr(summary,1,30) AS s FROM message ORDER BY idx LIMIT 6').all();
    console.log('样本:');
    for (const r of sample) console.log('  #' + r.idx + ' ' + r.kind + ' content=' + JSON.stringify(r.t) + ' summary=' + JSON.stringify(r.s));
  }
  if (tables.includes('plan')) {
    console.log('plan 行数:', db.prepare('SELECT COUNT(*) AS n FROM plan').get().n);
  }
  if (tables.includes('todo')) {
    console.log('todo 行数:', db.prepare('SELECT COUNT(*) AS n FROM todo').get().n);
  }
} catch (e) {
  console.log('查询失败:', e.message);
}
db.close();
" 2>&1 | head -28
  echo ""
done
