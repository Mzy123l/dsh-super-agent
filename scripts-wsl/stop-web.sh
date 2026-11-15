#!/bin/bash
# 停止 WSL 里的 dsh web（确保采集文件被 flush）
set -u
echo "=== 停止 dsh web（发 SIGTERM 让它优雅退出并 flush 采集）==="
pid=$(ss -ltnp 2>/dev/null | grep -E ':(8080|8081|8082|8083|8084|8085) ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
if [ -n "$pid" ]; then
  kill "$pid" 2>/dev/null
  echo "sent SIGTERM to pid=$pid"
  for i in $(seq 1 20); do
    sleep 1
    kill -0 "$pid" 2>/dev/null || { echo "已退出（等待 ${i}s）"; break; }
  done
  kill -0 "$pid" 2>/dev/null && { echo "仍在运行，强制结束"; kill -9 "$pid" 2>/dev/null; }
else
  echo "没有运行中的实例"
fi

echo ""
echo "=== 采集产物 ==="
CAPTURES="/mnt/c/Users/Assistant/projects/dsh-super-agent/captures"
if [ -d "$CAPTURES" ]; then
  ls -la "$CAPTURES"
  echo "--- 每行摘要（ts / variant / runId / turn / step / msgs / chars） ---"
  for f in "$CAPTURES"/*.jsonl; do
    [ -f "$f" ] || continue
    echo "== $(basename "$f") =="
    python3 - "$f" <<'PY'
import json,sys
p=sys.argv[1]
rows=[]
for line in open(p,encoding='utf-8'):
    line=line.strip()
    if not line: continue
    try: rows.append(json.loads(line))
    except Exception: pass
if not rows:
    print("  (空)"); raise SystemExit
for r in rows:
    t=r.get('totals',{})
    print("  variant=%-4s run=%-12s turn=%s step=%s msgs=%-4s chars=%-9s reasoning=%s" % (
        r.get('variant'), r.get('runId'), r.get('turn'), r.get('step'),
        t.get('messages'), t.get('chars'), t.get('reasoningChars')))
print("  共 %d 条" % len(rows))
PY
  done
else
  echo "（还没有采集目录）"
fi
exit 0
