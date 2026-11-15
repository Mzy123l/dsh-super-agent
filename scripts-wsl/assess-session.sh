#!/bin/bash
# 深入评估 WSL 会话行为：编号质量、summary 挂接、污染情况
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
const Database = require('better-sqlite3');
const db = new Database('$HOME/data/memory.sqlite', { readonly: true });

const SID = 'session-ce991f7b-7e51-4697-841a-a2fcffe5d314';

console.log('=== 1. kind 分布 ===');
for (const k of db.prepare('SELECT kind, COUNT(*) AS n FROM message WHERE sessionId=? GROUP BY kind').all(SID))
  console.log('  ' + k.kind.padEnd(9) + k.n);

console.log('');
console.log('=== 2. 污染统计 ===');
const total = db.prepare('SELECT COUNT(*) AS n FROM message WHERE sessionId=?').get(SID).n;
const pollute = db.prepare(\"SELECT COUNT(*) AS n FROM message WHERE sessionId=? AND (content LIKE '<system-reminder>%' OR content LIKE 'Time sampled%' OR content LIKE 'Generate the session title%' OR content LIKE '%condense unit%' OR content LIKE '%The task: condense%' OR content LIKE '%condense #%')\").get(SID).n;
console.log('  总数 ' + total + '，疑似污染 ' + pollute + ' 条 (' + (pollute*100/total).toFixed(1) + '%)');

console.log('');
console.log('=== 3. summary 覆盖 ===');
const withS = db.prepare(\"SELECT COUNT(*) AS n FROM message WHERE sessionId=? AND summary<>''\").get(SID).n;
console.log('  有 summary: ' + withS + ' / ' + total + ' (' + (withS*100/total).toFixed(1) + '%)');

console.log('');
console.log('=== 4. summary 是否挂错（内容与摘要语义不符）===');
const rows = db.prepare(\"SELECT idx, kind, content, summary FROM message WHERE sessionId=? AND summary<>'' ORDER BY idx\").all(SID);
for (const r of rows) {
  const c = r.content.split('\n')[0].slice(0, 46).replace(/\s+/g,' ');
  const s = r.summary.split('\n')[0].slice(0, 40).replace(/\s+/g,' ');
  console.log('  #' + String(r.idx).padStart(3) + ' ' + r.kind.padEnd(8));
  console.log('       内容: ' + c);
  console.log('       摘要: ' + s);
}

console.log('');
console.log('=== 5. 编号连续性检查 ===');
const idxs = db.prepare('SELECT idx FROM message WHERE sessionId=? ORDER BY idx').all(SID).map(r=>r.idx);
let gaps = [];
for (let i = 0; i < idxs.length; i++) if (idxs[i] !== i) { gaps.push(i + '→' + idxs[i]); if (gaps.length>3) break; }
console.log('  范围 ' + idxs[0] + '–' + idxs[idxs.length-1] + '，共 ' + idxs.length + ' 条');
console.log(gaps.length ? '  有跳号: ' + gaps.join(', ') : '  无跳号 ✓');

console.log('');
console.log('=== 6. 上下文状态 ===');
const inctx = db.prepare('SELECT COUNT(*) AS n FROM message WHERE sessionId=? AND in_context=1').get(SID).n;
console.log('  在上下文中: ' + inctx + ' / ' + total);
db.close();
" 2>&1 | head -70
