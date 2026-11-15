#!/bin/bash
# 验证插件装好并在运行时可用：dump-config 确认 + 启动后检查工具注册
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== 1. dump-config 里的插件条目 ==="
"$DSH" --profile web --dump-config 2>&1 | sed -n '/memory-plugin/,+3p' | head -6

echo ""
echo "=== 2. 构建产物完整性 ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
for f in dist/index.js dist/dsh-bundle.js dist/store/sqlite.js dist/store/schema.sql \
         dist/projection/executor.js dist/fold/store.js dist/plan/store.js \
         dist/todo/store.js dist/override/store.js; do
  if [ -f "$f" ]; then echo "  ok   $f"; else echo "  MISS $f"; fi
done

echo ""
echo "=== 3. CLI 可用性 ==="
node dist/cli.js 2>&1 | head -16

echo ""
echo "=== 4. 真实启动并确认无激活错误 ==="
LOG=/tmp/dsh-verify-install.log
rm -f "$LOG"
cd "$HOME" || exit 1
setsid nohup "$DSH" --profile web --port 8099 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 14
if grep -q "did not activate\|failed to import" "$LOG"; then
  echo "有错误："
  grep -A5 "did not activate\|failed to import" "$LOG" | head -12
else
  echo "插件激活正常，无错误"
fi
echo "启动行：$(head -1 "$LOG")"
P=$(ss -ltnp 2>/dev/null | sed -n 's/.*:8099 .*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; fi
exit 0
