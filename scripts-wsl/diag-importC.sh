#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

LOG=/tmp/dsh-diagA.log
rm -f "$LOG"
echo "回复：好" | NODE_DEBUG=esm timeout 25 "$DSH" --profile web --no-open > "$LOG" 2>&1

echo "--- memory-plugin 相关 ---"
grep -i -B2 -A4 "memory-plugin" "$LOG" | head -30

echo ""
echo "--- ERR_ACCESS / Cannot find / ERR_MODULE 相关 ---"
grep -E "ERR_|Cannot find|ERR_MODULE" "$LOG" | head -15
exit 0
