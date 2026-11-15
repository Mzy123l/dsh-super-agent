#!/bin/bash
# 核实：summary 与内容的对应关系是否错位
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
const Database = require('better-sqlite3');
const db = new Database('$HOME/data/memory.sqlite', { readonly: true });
const SID = 'session-ce991f7b-7e51-4697-841a-a2fcffe5d314';

console.log('=== 完整内容 vs 摘要（前 3 条，含全文片段）===');
const rows = db.prepare(\"SELECT idx, kind, content, summary FROM message WHERE sessionId=? AND summary<>'' ORDER BY idx LIMIT 3\").all(SID);
for (const r of rows) {
  console.log('');
  console.log('--- #' + r.idx + ' ' + r.kind + ' ---');
  console.log('内容全文长度: ' + r.content.length);
  console.log('内容片段: ' + JSON.stringify(r.content.slice(0, 300)));
  console.log('摘要全文长度: ' + r.summary.length);
  console.log('摘要片段: ' + JSON.stringify(r.summary.slice(0, 200)));
}

console.log('');
console.log('=== 检查：这条摘要是否出现在别处的内容里 ===');
const target = rows[0];
if (target) {
  const key = target.summary.slice(0, 20);
  console.log('用摘要开头查询: ' + JSON.stringify(key));
  const found = db.prepare('SELECT idx, kind, substr(content,1,60) AS c FROM message WHERE sessionId=? AND content LIKE ?').all(SID, '%' + key + '%');
  console.log('该摘要文字出现在 ' + found.length + ' 条消息里:');
  for (const f of found) console.log('  #' + f.idx + ' ' + f.kind + ' → ' + JSON.stringify(f.c));
}

console.log('');
console.log('=== pending_summary 状态 ===');
try {
  const p = db.prepare('SELECT * FROM pending_summary').all();
  console.log('待处理: ' + p.length + ' 条');
  for (const x of p) console.log('  会话 ' + x.sessionId.slice(0,8) + ' 单位 #' + x.unitIdx);
} catch(e) { console.log('查询失败: ' + e.message); }

console.log('');
console.log('=== summary_reply_fp 指纹数量 ===');
try {
  console.log(db.prepare('SELECT COUNT(*) AS n FROM summary_reply_fp').get().n + ' 条指纹');
} catch(e) { console.log('查询失败'); }
db.close();
" 2>&1 | head -55
