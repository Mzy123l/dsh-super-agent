#!/bin/bash
# 启动 WSL 里的 dsh web 并输出可访问的 URL
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
PORT="${1:-8085}"

echo "=== 停止占用端口的旧实例 ==="
for p in $(seq 8080 8090); do
  P=$(ss -ltnp 2>/dev/null | sed -n "s/.*:$p .*pid=\([0-9]*\).*/\1/p" | head -1)
  if [ -n "$P" ]; then kill "$P" 2>/dev/null && echo "killed $P on :$p"; fi
done

echo ""
echo "=== 启动 dsh web on :$PORT ==="
LOG=/tmp/dsh-web-$PORT.log
rm -f "$LOG"
cd "$HOME" || exit 1
setsid nohup "$DSH" --profile web --port "$PORT" --no-open > "$LOG" 2>&1 < /dev/null &

for i in $(seq 1 40); do
  sleep 1
  if grep -q 'http://127.0.0.1' "$LOG" 2>/dev/null; then break; fi
done

echo "--- 日志 ---"
head -6 "$LOG"
echo ""
URL=$(sed -n 's/.*\(http:\/\/127\.0\.0\.1:[0-9]*\/?token=[A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1)
if [ -z "$URL" ]; then
  echo "未拿到 URL，完整日志："
  cat "$LOG"
  exit 1
fi
echo "URL=$URL"
exit 0
