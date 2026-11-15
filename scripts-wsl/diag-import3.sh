#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== profile package.json ==="
cat "$HOME/.dsh/profiles/web/package.json" 2>/dev/null

echo ""
echo "=== profile node_modules 里有没有插件 ==="
ls -la "$HOME/.dsh/profiles/web/node_modules/dsh-memory-plugin" 2>/dev/null || echo "（无 dsh-memory-plugin 链接）"
ls "$HOME/.dsh/profiles/web/node_modules/@deepseek-ai/" 2>/dev/null | head -10

echo ""
echo "=== dsh 完整启动日志（含加载错误细节）==="
DSH="$HOME/.npm-global/bin/dsh"
LOG=/tmp/dsh-diag3.log
rm -f "$LOG"
timeout 20 "$DSH" --profile web --dump-config > "$LOG" 2>&1
cat "$LOG" | head -30
exit 0
