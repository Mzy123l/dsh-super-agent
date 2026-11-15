#!/bin/bash
# 清理旧库并验证插件加载
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"

echo "=== 1. 清理旧数据库 ==="
find "$HOME" -name 'memory.sqlite*' -not -path '*/node_modules/*' 2>/dev/null | while read -r f; do
  rm -f "$f" && echo "removed: $f"
done
find "$HOME/dsh-plugins" -type d -name data 2>/dev/null | while read -r d; do
  rm -rf "$d" && echo "removed dir: $d"
done

echo ""
echo "=== 2. 同步源码并重建 ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
rm -rf src dist
cp -rf "$REPO/memory-plugin/src" .
cp -f "$REPO/memory-plugin/package.json" "$REPO/memory-plugin/tsconfig.json" \
      "$REPO/memory-plugin/tsconfig.build.json" .
cp -rf "$REPO/memory-plugin/scripts" .
npm run build 2>&1 | tail -4

echo ""
echo "=== 3. 启动 web 验证加载 ==="
LOG=/tmp/dsh-v4.log
rm -f "$LOG"
cd "$HOME" || exit 1
setsid nohup "$DSH" --profile web --port 8096 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 15
echo "--- 日志 ---"
head -12 "$LOG"
echo ""
echo "--- 错误检查 ---"
if grep -q "did not activate\|failed to import\|Error" "$LOG"; then
  grep -A4 "did not activate\|failed to import\|Error" "$LOG" | head -12
else
  echo "无插件错误"
fi
P=$(ss -ltnp 2>/dev/null | sed -n 's/.*:8096 .*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; echo "stopped $P"; fi
exit 0
