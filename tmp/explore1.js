// 探索：找出所有 compaction 事件的字段形状
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const M = 0xFD2FB528;

function decomp(file) {
  const b = fs.readFileSync(file); let off = 0, out = '';
  while (off < b.length - 4) {
    if (b.readUInt32LE(off) !== M) break;
    let p = off + 4; const fhd = b[p]; p++;
    const fcsFlag = fhd >> 6, singleSeg = (fhd >> 5) & 1, checksum = (fhd >> 2) & 1, dictFlag = fhd & 3;
    p += singleSeg ? 0 : 1;
    p += dictFlag === 0 ? 0 : (dictFlag === 1 ? 1 : (dictFlag === 2 ? 2 : 4));
    p += [singleSeg ? 1 : 0, 2, 4, 8][fcsFlag];
    for (;;) {
      const bh = b[p] | (b[p + 1] << 8) | (b[p + 2] << 16); p += 3;
      const last = bh & 1, type = (bh >> 1) & 3, size = bh >>> 3;
      if (type === 3) break; p += size; if (last) break;
    }
    if (checksum) p += 4;
    try { out += zlib.zstdDecompressSync(b.subarray(off, p)).toString('utf8') } catch (e) { }
    off = p;
  }
  return out;
}

const root = 'C:\\Users\\Assistant\\.dsh\\sessions';
const files = [];
(function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const fp = path.join(d, e.name);
    if (e.isDirectory()) walk(fp);
    else if (e.name.endsWith('.jsonl.zstd')) files.push(fp);
  }
})(root);

console.log('files', files.length);
const shapes = new Map();
let sample = null;
for (const f of files) {
  const txt = decomp(f);
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    let j; try { j = JSON.parse(line) } catch { continue }
    const type = j.type || j.kind || '';
    if (typeof type === 'string' && type.includes('compaction')) {
      const key = type + ' :: ' + Object.keys(j).sort().join(',');
      if (!shapes.has(key)) shapes.set(key, { count: 0, file: path.basename(path.dirname(f)), ex: j });
      shapes.get(key).count++;
    }
  }
}
for (const [k, v] of shapes) {
  console.log('\n=== ' + k + '  x' + v.count + '  (' + v.file + ')');
}
