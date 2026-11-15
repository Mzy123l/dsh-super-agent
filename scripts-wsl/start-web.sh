#!/bin/bash
# WSL 里的 dsh web + 记忆插件 + 采集插件
#
# 用法：
#   ./start-web.sh [端口] [variant] [runId]
# 例：
#   ./start-web.sh 8085 on  run-a        # 启用记忆插件的采集轮
#   ./start-web.sh 8085 off run-b        # 不启用记忆插件的采集轮
#
# 凭据由使用者自行在 Web UI 登录/添加，本脚本不碰任何账号与密钥。
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

PORT="${1:-8085}"
VARIANT="${2:-on}"
RUNID="${3:-run-local}"

REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"
CAPTURES="$REPO/captures"
mkdir -p "$CAPTURES"

echo "=== 停止旧实例 ==="
for p in 8080 8081 8082 8083 8084 8085; do
  pid=$(ss -ltnp 2>/dev/null | grep ":$p " | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
  [ -n "$pid" ] && kill "$pid" 2>/dev/null && echo "killed pid=$pid on :$p"
done
sleep 2

echo ""
echo "=== 同步插件源码并重建 ==="
for p in memory-plugin memory-debug-capture; do
  if [ -d "$REPO/$p" ]; then
    mkdir -p "$HOME/dsh-plugins/$p/src"
    cp -f "$REPO/$p"/src/*.ts "$HOME/dsh-plugins/$p/src/" 2>/dev/null
    cp -f "$REPO/$p"/package.json "$HOME/dsh-plugins/$p/" 2>/dev/null
    cp -f "$REPO/$p"/tsconfig*.json "$HOME/dsh-plugins/$p/" 2>/dev/null
    cp -f "$REPO/$p"/cordis.patch.yml "$HOME/dsh-plugins/$p/" 2>/dev/null
    (cd "$HOME/dsh-plugins/$p" && npm run build 2>&1 | tail -3)
  fi
done

echo ""
echo "=== 启动（variant=$VARIANT runId=$RUNID）==="
LOG="/tmp/dsh-web.log"
rm -f "$LOG"
export MEMORY_DEBUG_OUT="$CAPTURES"
export MEMORY_DEBUG_VARIANT="$VARIANT"
export MEMORY_DEBUG_RUN_ID="$RUNID"
export MEMORY_SESSIONS_DIR="$HOME/.dsh/sessions"
export MEMORY_DATA_DIR="$HOME/dsh-plugins/memory-plugin/data"
setsid nohup "$DSH" --profile web --port "$PORT" --no-open > "$LOG" 2>&1 < /dev/null &
sleep 16

echo "--- 启动日志 ---"
head -20 "$LOG"
echo ""
echo "--- 插件状态 ---"
if grep -qiE "did not activate|startup failed" "$LOG"; then
  echo "插件有错误："
  grep -iE "did not activate|startup failed|Error:" "$LOG" | head -8
else
  echo "两个插件均已激活"
fi

TOKEN=$(grep -oE 'token=[A-Za-z0-9_-]+' "$LOG" | head -1 | cut -d= -f2)
echo ""
echo "================================================"
echo " Web UI:  http://127.0.0.1:$PORT/?token=$TOKEN"
echo " 采集输出: $CAPTURES  (variant=$VARIANT runId=$RUNID)"
echo "================================================"
echo ""
echo "接下来："
echo " 1) 打开上面的 URL，用你自己的账号登录（脚本不碰凭据）"
echo " 2) 新建会话，选工作区 /mnt/c/Users/Assistant/projects/dsh-super-agent"
echo " 3) 聊几轮，让上下文涨起来"
echo " 4) 回来跑：bash scripts-wsl/stop-web.sh   然后切换 variant 再起一轮"
echo " 5) 生成对比页：node tools/dist/gen-memory-debug.js --on <on.jsonl> --off <off.jsonl> --out memory-debug.html"
exit 0
