#!/bin/bash
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
(async () => {
  const mod = await import('./dist/summary/validate.js');
  const { validateSummary, termOverlap, extractTerms } = mod;
  const Database = require('better-sqlite3');
  const db = new Database('$HOME/data/memory.sqlite', { readonly: true });
  const rows = db.prepare(\"SELECT idx, kind, content, summary FROM message WHERE summary<>'' ORDER BY idx\").all();

  console.log('=== 唯一通过的 ===');
  for (const r of rows) {
    const s = r.summary.replace(/^\[已覆写\]\s*/, '');
    const v = validateSummary(s, r.content);
    if (v.ok) {
      console.log('#' + r.idx + ' ' + r.kind + ' 重合 ' + (termOverlap(s, r.content)*100).toFixed(0) + '%');
      console.log('  内容: ' + JSON.stringify(r.content.slice(0,80)));
      console.log('  摘要: ' + JSON.stringify(s.slice(0,80)));
    }
  }

  console.log('');
  console.log('=== 高重合但被拒的（误伤嫌疑）===');
  const cand = rows.map(r => ({...r, s: r.summary.replace(/^\[已覆写\]\s*/,''), ov: termOverlap(r.summary.replace(/^\[已覆写\]\s*/,''), r.content)}))
    .filter(x => x.ov >= 0.15);
  console.log('重合≥15% 的条数: ' + cand.length);
  for (const c of cand) {
    const v = validateSummary(c.s, c.content);
    if (!v.ok) {
      console.log('');
      console.log('#' + c.idx + ' ' + c.kind + ' 重合 ' + (c.ov*100).toFixed(0) + '%');
      console.log('  拒收原因: ' + v.reason);
      console.log('  内容实词样例: ' + extractTerms(c.content).slice(0,8).join(','));
      console.log('  摘要实词样例: ' + extractTerms(c.s).slice(0,8).join(','));
    }
  }
  db.close();
})();
" 2>&1 | head -45
