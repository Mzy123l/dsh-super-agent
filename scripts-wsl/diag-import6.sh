#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

LOG=/tmp/dsh-diag6.log
rm -f "$LOG"
echo "回复一个字：好" | timeout 30 "$DSH" --profile web > "$LOG" 2>&1
echo "--- 前 25 行 ---"
head -25 "$LOG"
echo "--- memory 相关 ---"
grep -i "memory" "$LOG" | head -10
exit 0
