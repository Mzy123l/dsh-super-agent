#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== 用 headless 短会话抓完整错误 ==="
LOG=/tmp/dsh-diag4.log
rm -f "$LOG"
timeout 25 "$DSH" --profile web "回复一个字：好" > "$LOG" 2>&1
echo "--- 全部日志 ---"
cat "$LOG" | head -40
exit 0
