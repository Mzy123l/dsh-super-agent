#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

# 用 stdin 传 prompt，抓完整启动日志
LOG=/tmp/dsh-diag5.log
rm -f "$LOG"
echo "回复一个字：好" | timeout 30 "$DSH" --profile web --json > "$LOG" 2>&1
echo "--- 错误相关行 ---"
grep -n -i -A4 "error\|failed\|cannot\|memory" "$LOG" 2>/dev/null | head -40 || cat "$LOG" | head -40
exit 0
