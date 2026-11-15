#!/bin/bash
set -u
export PATH="$HOME/.npm-global/bin:$PATH"
DSHROOT="$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh"

echo "=== 1. dsh 0.2.2-rc.3 自带的 @deepseek-ai 包版本 ==="
for p in cordis dsh-tools dsh-llm dsh-session dsh-agent-loop dsh-attachment; do
  f="$DSHROOT/node_modules/@deepseek-ai/$p/package.json"
  if [ -f "$f" ]; then
    v=$(grep -m1 '"version"' "$f" | tr -d ' ",' | cut -d: -f2)
    echo "  $p: $v"
  else
    # 也可能是提升到上层
    f2="$HOME/.npm-global/lib/node_modules/@deepseek-ai/$p/package.json"
    if [ -f "$f2" ]; then
      v=$(grep -m1 '"version"' "$f2" | tr -d ' ",' | cut -d: -f2)
      echo "  $p: $v（提升到顶层）"
    else
      echo "  $p: 未找到"
    fi
  fi
done

echo ""
echo "=== 2. npm 上对应版本是否存在 ==="
for v in 0.2.2-rc.3; do
  echo "--- @deepseek-ai/dsh-tools@$v ---"
  npm view "@deepseek-ai/dsh-tools@$v" version 2>&1 | head -2
  echo "--- @deepseek-ai/dsh-llm@$v ---"
  npm view "@deepseek-ai/dsh-llm@$v" version 2>&1 | head -2
done

echo ""
echo "=== 3. 当前插件能否在升级后的 dsh 上加载 ==="
LOG=/tmp/dsh-after-upgrade.log
rm -f "$LOG"
cd "$HOME" || exit 1
setsid nohup "$HOME/.npm-global/bin/dsh" --profile web --port 8100 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 16
echo "--- 日志 ---"
head -12 "$LOG"
echo ""
if grep -q "did not activate\|failed to import" "$LOG"; then
  echo "有激活错误："
  grep -A6 "did not activate\|failed to import" "$LOG" | head -16
else
  echo "插件激活正常"
fi
P=$(ss -ltnp 2>/dev/null | sed -n 's/.*:8100 .*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; fi
exit 0
