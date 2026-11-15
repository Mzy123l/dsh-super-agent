#!/bin/bash
# 分析拒收原因分布，判断阈值是否过严
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
(async () => {
  const mod = await import('./dist/summary/validate.js');
  const validate = mod.validateSummary;
  const { termOverlap } = mod;
  const Database = require('better-sqlite3');
  const db = new Database('$HOME/data/memory.sqlite', { readonly: true });
  const rows = db.prepare(\"SELECT idx, kind, content, summary FROM message WHERE summary<>'' ORDER BY idx\").all();

  const byReason = {};
  const overlaps = [];
  const ratios = [];

  for (const r of rows) {
    const s = r.summary.replace(/^\[已覆写\]\s*/, '');
    const v = validate(s, r.content);
    const key = !v.ok ? (v.reason.includes('过程性') ? '过程性' : v.reason.includes('未收敛') ? '长度超限' : v.reason.includes('串位') ? '重合不足' : '其他') : '通过';
    byReason[key] = (byReason[key] || 0) + 1;
    overlaps.push(termOverlap(s, r.content));
    ratios.push(r.content.length > 0 ? s.length / r.content.length : 0);
  }

  console.log('=== 拒收原因分布 ===');
  for (const [k, n] of Object.entries(byReason)) console.log('  ' + k + ': ' + n);

  console.log('');
  console.log('=== 重合率分布 ===');
  const buckets = [0, 0.05, 0.15, 0.3, 0.5, 1.01];
  for (let i = 0; i < buckets.length - 1; i++) {
    const n = overlaps.filter(x => x >= buckets[i] && x < buckets[i+1]).length;
    console.log('  ' + (buckets[i]*100).toFixed(0) + '%-' + (buckets[i+1]*100).toFixed(0) + '%: ' + n);
  }

  console.log('');
  console.log('=== 长度比例分布 ===');
  const rb = [0, 0.1, 0.2, 0.4, 0.6, 1.01];
  for (let i = 0; i < rb.length - 1; i++) {
    const n = ratios.filter(x => x >= rb[i] && x < rb[i+1]).length;
    console.log('  ' + (rb[i]*100).toFixed(0) + '%-' + (rb[i+1]*100).toFixed(0) + '%: ' + n);
  }

  console.log('');
  console.log('=== 高重合样本（这些其实提炼得不错）===');
  const good = rows.map((r, i) => ({ ...r, ov: overlaps[i] })).filter(x => x.ov >= 0.2).sort((a,b) => b.ov - a.ov).slice(0, 5);
  for (const g of good) {
    console.log('');
    console.log('#' + g.idx + ' 重合 ' + (g.ov*100).toFixed(0) + '%');
    console.log('  内容: ' + JSON.stringify(g.content.slice(0, 70)));
    console.log('  摘要: ' + JSON.stringify(g.summary.slice(0, 70)));
  }
  db.close();
})();
" 2>&1 | head -55
