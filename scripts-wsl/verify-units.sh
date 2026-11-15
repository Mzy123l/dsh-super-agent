#!/bin/bash
# 核实两个疑点：
# 1. 编号 0 是不是真的「第一个 user prompt」——样本里 #0 看起来是真实提问
# 2. 有没有 system-reminder 混进了单位（#1 #2 #3 看起来可疑）
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
const Database = require('better-sqlite3');
const db = new Database('$HOME/data/memory.sqlite', { readonly: true });

console.log('=== 全部 61 条单位的 kind 分布 ===');
const kinds = db.prepare('SELECT kind, COUNT(*) AS n FROM message GROUP BY kind').all();
for (const k of kinds) console.log('  ' + k.kind + ': ' + k.n);

console.log('');
console.log('=== 每条的首行（判断是否该被索引）===');
const rows = db.prepare('SELECT idx, kind, content, summary, in_context FROM message ORDER BY idx').all();
for (const r of rows) {
  const first = r.content.split('\n')[0].slice(0, 62).replace(/\s+/g, ' ');
  const mark = r.summary ? '[S]' : '   ';
  const ctx = r.in_context ? '' : ' (off)';
  console.log('  ' + mark + ' #' + String(r.idx).padStart(2) + ' ' + r.kind.padEnd(8) + ' ' + first + ctx);
}

console.log('');
console.log('=== 可疑项统计 ===');
const suspicious = rows.filter(r =>
  r.content.startsWith('<system-reminder>') ||
  r.content.startsWith('Time sampled') ||
  r.content.startsWith('Generate the session title')
);
console.log('不该成为单位的消息数:', suspicious.length, '/ 总数', rows.length);
db.close();
" 2>&1 | head -75
