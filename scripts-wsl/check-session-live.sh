#!/bin/bash
# 检查 WSL 里的 dsh web 是否真的在用插件
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== 1. 服务是否在跑 ==="
ss -ltnp 2>/dev/null | grep ':8085' || echo "（8085 未监听）"

echo ""
echo "=== 2. 启动日志 ==="
LOG=/tmp/dsh-web-8085.log
if [ -f "$LOG" ]; then
  echo "行数: $(wc -l < "$LOG")"
  head -20 "$LOG"
else
  echo "（日志不存在）"
fi

echo ""
echo "=== 3. 插件是否激活（日志里有无报错）==="
if [ -f "$LOG" ]; then
  if grep -q "did not activate\|failed to import" "$LOG"; then
    echo "有错误："
    grep -A5 "did not activate\|failed to import" "$LOG" | head -12
  else
    echo "无激活错误"
  fi
  echo ""
  echo "--- 所有 memory 相关日志 ---"
  grep -i "memory" "$LOG" | head -15 || echo "（无 memory 日志）"
fi

echo ""
echo "=== 4. 插件数据目录（有没有真的写库）==="
for d in "$HOME/data" "$HOME/dsh-plugins/memory-plugin/data" "$HOME/.dsh/data"; do
  if [ -e "$d/memory.sqlite" ]; then
    sz=$(stat -c%s "$d/memory.sqlite" 2>/dev/null)
    echo "  找到库: $d/memory.sqlite (${sz} 字节)"
  fi
done

echo ""
echo "=== 5. 会话日志（dsh 自己的）==="
SESSDIR="$HOME/.dsh/sessions"
if [ -d "$SESSDIR" ]; then
  echo "会话文件数: $(find "$SESSDIR" -type f | wc -l)"
  find "$SESSDIR" -type f -newermt '-30 minutes' 2>/dev/null | head -5
else
  echo "（无会话目录）"
fi
exit 0
