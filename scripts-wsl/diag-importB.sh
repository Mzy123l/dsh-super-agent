#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== 用 NODE_DEBUG=module 看 dsh 加载 memory-plugin 的过程 ==="
LOG=/tmp/dsh-diagA.log
rm -f "$LOG"
echo "回复：好" | NODE_DEBUG=esm,module timeout 25 "$DSH" --profile web --no-open > "$LOG" 2>&1
grep -i -A2 "memory" "$LOG" | head -30
echo ""
echo "=== 或检查 dsh 启动时的 verbose 日志开关 ==="
"$HOME/.npm-global/bin/dsh" --help 2>&1 | grep -i -E "verbose|debug|log" | head -6
exit 0
