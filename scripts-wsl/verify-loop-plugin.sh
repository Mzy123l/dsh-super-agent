#!/bin/bash
# 验证插件被 dsh 加载且 pre-step 钩子挂上
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== profile 是否含 memory-plugin ==="
"$DSH" --profile web --dump-config 2>&1 | sed -n '/memory-plugin/,+3p' | head -8

echo ""
echo "=== 启动 web 看插件是否激活 ==="
LOG=/tmp/dsh-loop-check.log
rm -f "$LOG"
setsid nohup "$DSH" --profile web --port 8090 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 14
echo "--- 启动日志 ---"
head -20 "$LOG"
echo ""
echo "--- 错误检查 ---"
if sed -n '/did not activate\|startup failed\|Error:/p' "$LOG" | head -5; then
  :
fi
sed -n '/did not activate\|startup failed/p' "$LOG" | head -3 || echo "（无插件激活错误）"
TOKEN=$(sed -n 's/.*token=\([A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1)
echo "URL: http://127.0.0.1:8090/?token=${TOKEN:0:8}…"
pid=$(sed -n 's/^dsh web.*//p' "$LOG" >/dev/null; echo "")
echo ""
echo "=== 停止 ==="
PORT=8090
P=$(ss -ltnp 2>/dev/null | sed -n "s/.*:$PORT .*pid=\([0-9]*\).*/\1/p" | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; echo "sent SIGTERM to $P"; fi
exit 0
