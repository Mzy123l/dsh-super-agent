#!/bin/bash
# 重建插件 + 清理端口 + 启动 web + 验证插件激活
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== 重建 memory-plugin ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
# 同步 Windows 侧源码（构建产物在 WSL 侧生成）
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent/memory-plugin"
cp -f "$REPO/src/dsh-bundle.ts" src/dsh-bundle.ts
cp -f "$REPO/src/index.ts" src/index.ts
npm run build 2>&1 | tail -5
echo "build exit=$?"

echo ""
echo "=== 清理端口 ==="
for p in 8080 8081 8082 8083; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "killed pid=$pid on :$p"
done
sleep 2

echo ""
echo "=== 启动 web ==="
PORT="${1:-8083}"
LOG="/tmp/dsh-web.log"
rm -f "$LOG"
export MEMORY_DEBUG_OUT="/mnt/c/Users/Assistant/projects/dsh-super-agent/captures"
export MEMORY_DEBUG_VARIANT="${2:-on}"
export MEMORY_DEBUG_RUN_ID="${3:-run-wsl-01}"
setsid nohup "$DSH" --profile web --port "$PORT" --no-open > "$LOG" 2>&1 < /dev/null &
sleep 16

echo "--- 日志 ---"
head -25 "$LOG"
echo ""
echo "--- 插件激活状态 ---"
grep -iE "did not activate|startup failed|memory-plugin|memory-debug" "$LOG" | head -10 || echo "（无插件错误）"
echo ""
TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" | head -1 | cut -d= -f2)
echo "URL: http://127.0.0.1:$PORT/?token=$TOKEN"
exit 0
