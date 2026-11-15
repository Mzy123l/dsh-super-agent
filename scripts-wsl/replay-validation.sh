#!/bin/bash
# 用真实 WSL 历史数据回放校验：修复能抓住多少已存在的串位
set -u
cd "$HOME/dsh-plugins/memory-plugin" || exit 1

node -e "
const Database = require('better-sqlite3');
const { validateSummary } = require('./dist/summary/validate.js');

// validate 是 ESM，改用动态导入
(async () => {
  const mod = await import('./dist/summary/validate.js');
  const validate = mod.validateSummary;

  const db = new Database('$HOME/data/memory.sqlite', { readonly: true });
  const rows = db.prepare(\"SELECT sessionId, idx, kind, content, summary FROM message WHERE summary<>'' ORDER BY idx\").all();

  let pass = 0, reject = 0;
  const rejected = [];

  for (const r of rows) {
    // 去掉覆写标记后校验
    const s = r.summary.replace(/^\[已覆写\]\s*/, '');
    const v = validate(s, r.content);
    if (v.ok) pass++;
    else {
      reject++;
      rejected.push({ idx: r.idx, kind: r.kind, reason: v.reason, s: s.slice(0, 60), c: r.content.slice(0, 60) });
    }
  }

  console.log('=== 用新校验回放历史数据 ===');
  console.log('总摘要数:', rows.length);
  console.log('通过:', pass);
  console.log('拒收:', reject, '(' + (reject*100/rows.length).toFixed(1) + '%)');

  console.log('');
  console.log('=== 被拒收的前 8 条（这些就是历史串位）===');
  for (const x of rejected.slice(0, 8)) {
    console.log('');
    console.log('#' + x.idx + ' ' + x.kind);
    console.log('  原因: ' + x.reason);
    console.log('  内容: ' + JSON.stringify(x.c));
    console.log('  摘要: ' + JSON.stringify(x.s));
  }
  db.close();
})();
" 2>&1 | head -55
