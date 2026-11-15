#!/bin/bash
# 核查：串位问题在最新数据里是否仍存在
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
const Database = require('better-sqlite3');
const db = new Database('$HOME/data/memory.sqlite', { readonly: true });

console.log('=== 全库总览 ===');
console.log('单位总数:', db.prepare('SELECT COUNT(*) AS n FROM message').get().n);
const withS = db.prepare(\"SELECT COUNT(*) AS n FROM message WHERE summary<>''\").get().n;
console.log('有摘要:', withS);

console.log('');
console.log('=== 逐条核查摘要是否与内容相关（关键词重合度）===');
const rows = db.prepare(\"SELECT sessionId, idx, kind, content, summary FROM message WHERE summary<>'' ORDER BY sessionId, idx\").all();
let suspicious = 0;
for (const r of rows) {
  // 提取内容里的英文/中文实词，看是否出现在摘要里
  const contentWords = (r.content.match(/[a-zA-Z_][a-zA-Z0-9_-]{3,}/g) || [])
    .map(w => w.toLowerCase()).filter(w => !['tool','call','name','bash','echo','true','false','json','command','description','result','error'].includes(w));
  const summaryLower = r.summary.toLowerCase();
  const hit = contentWords.filter(w => summaryLower.includes(w)).length;
  const ratio = contentWords.length > 0 ? hit / contentWords.length : 1;

  // 占比低于 15% 且词数够多 → 可疑
  if (contentWords.length >= 8 && ratio < 0.15) {
    suspicious++;
    console.log('');
    console.log('⚠ 可疑 #' + r.idx + ' ' + r.kind + ' (重合 ' + (ratio*100).toFixed(0) + '%)');
    console.log('  内容: ' + JSON.stringify(r.content.slice(0, 90)));
    console.log('  摘要: ' + JSON.stringify(r.summary.slice(0, 90)));
  }
}
console.log('');
console.log('可疑条数: ' + suspicious + ' / ' + rows.length);

console.log('');
console.log('=== pending 与指纹 ===');
console.log('待处理 pending:', db.prepare('SELECT COUNT(*) AS n FROM pending_summary').get().n);
console.log('回复指纹:', db.prepare('SELECT COUNT(*) AS n FROM summary_reply_fp').get().n);
db.close();
" 2>&1 | head -60
