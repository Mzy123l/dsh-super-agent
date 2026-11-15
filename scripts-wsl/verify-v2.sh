#!/bin/bash
# 验证重构后的插件能被 dsh 真正加载并启动
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"

echo "=== 1. 同步源码与配置 ==="
mkdir -p "$HOME/dsh-plugins/memory-plugin"
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
rm -rf src dist
cp -rf "$REPO/memory-plugin/src" .
cp -f "$REPO/memory-plugin/package.json" "$REPO/memory-plugin/tsconfig.json" \
      "$REPO/memory-plugin/tsconfig.build.json" .
cp -rf "$REPO/memory-plugin/scripts" .

echo "=== 2. 安装依赖并构建 ==="
npm install --silent 2>&1 | tail -2
npm run build 2>&1 | tail -5

echo ""
echo "=== 3. 构建产物 ==="
ls dist/*.js 2>/dev/null | head -14

echo ""
echo "=== 4. 启动 web，检查插件激活 ==="
LOG=/tmp/dsh-mem-v2.log
rm -f "$LOG"
setsid nohup "$DSH" --profile web --port 8095 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 15
echo "--- 启动日志前 12 行 ---"
head -12 "$LOG"
echo "--- 激活错误检查 ---"
if sed -n '/did not activate\|failed to activate\|cannot get property\|cannot set property/p' "$LOG" | head -5; then
  :
fi
sed -n '/did not activate\|failed to activate\|cannot get property\|cannot set property/p' "$LOG" | head -5 || true
echo "--- URL ---"
sed -n 's/.*\(http:\/\/127\.0\.0\.1:8095\/?token=[A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1

echo ""
echo "=== 5. 停止 ==="
P=$(ss -ltnp 2>/dev/null | sed -n 's/.*:8095 .*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; echo "sent SIGTERM to $P"; sleep 2; fi
exit 0
