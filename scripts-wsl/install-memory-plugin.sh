#!/bin/bash
# 在 WSL 里安装 memory-plugin：同步源码 → 构建 → 挂到 web profile → 验证加载
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"

echo "=== 0. 环境检查 ==="
node -v
"$DSH" --version 2>&1 | head -1

echo ""
echo "=== 1. 同步源码到 ~/dsh-plugins/memory-plugin ==="
mkdir -p "$HOME/dsh-plugins/memory-plugin"
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
rm -rf src dist tests
cp -rf "$REPO/memory-plugin/src" .
cp -rf "$REPO/memory-plugin/tests" .
cp -rf "$REPO/memory-plugin/scripts" .
cp -f "$REPO/memory-plugin/package.json" \
      "$REPO/memory-plugin/tsconfig.json" \
      "$REPO/memory-plugin/tsconfig.build.json" \
      "$REPO/memory-plugin/cordis.patch.yml" .
echo "源码已同步：$(find src -name '*.ts' | wc -l) 个 ts 文件"

echo ""
echo "=== 2. 安装依赖并构建 ==="
npm install --silent 2>&1 | tail -2
npm run build 2>&1 | tail -4
echo "构建产物："
ls dist/*.js 2>/dev/null | head -6

echo ""
echo "=== 3. 清理旧数据库（schema 变过，必须重建）==="
find "$HOME/dsh-plugins/memory-plugin" -path '*/data/*' -name 'memory.sqlite*' -delete 2>/dev/null
echo "旧库已清理"

echo ""
echo "=== 4. 挂到 web profile ==="
"$DSH" plugin --profile web add "link:$HOME/dsh-plugins/memory-plugin" 2>&1 | tail -3

echo ""
echo "=== 5. 确认 profile 状态 ==="
cat "$HOME/.dsh/profiles/web/package.json" 2>/dev/null

echo ""
echo "=== 6. 启动验证加载 ==="
LOG=/tmp/dsh-install-check.log
rm -f "$LOG"
cd "$HOME" || exit 1
setsid nohup "$DSH" --profile web --port 8098 --no-open > "$LOG" 2>&1 < /dev/null &
sleep 15
echo "--- 启动日志 ---"
head -10 "$LOG"
echo ""
echo "--- 错误检查 ---"
if grep -q "did not activate\|failed to import\|SqliteError\|Error:" "$LOG"; then
  grep -A4 "did not activate\|failed to import\|SqliteError\|Error:" "$LOG" | head -14
else
  echo "无插件错误"
fi
echo ""
echo "--- URL ---"
sed -n 's/.*\(http:\/\/127\.0\.0\.1:8098\/?token=[A-Za-z0-9_-]*\).*/\1/p' "$LOG" | head -1
P=$(ss -ltnp 2>/dev/null | sed -n 's/.*:8098 .*pid=\([0-9]*\).*/\1/p' | head -1)
if [ -n "$P" ]; then kill "$P" 2>/dev/null; echo ""; echo "已停止测试实例 $P"; fi
exit 0
