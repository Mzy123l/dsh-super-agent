#!/bin/bash
# 升级 WSL 里的 dsh 到 0.2.2-rc.3（与 Windows 侧一致），并重建插件
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

TARGET="0.2.2-rc.3"

echo "=== 1. 升级前的版本 ==="
"$HOME/.npm-global/bin/dsh" --version 2>&1 | head -1

echo ""
echo "=== 2. 安装 $TARGET ==="
npm install -g "@deepseek-ai/dsh@$TARGET" 2>&1 | tail -6

echo ""
echo "=== 3. 升级后的版本 ==="
"$HOME/.npm-global/bin/dsh" --version 2>&1 | head -1
grep -m1 '"version"' "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json" 2>/dev/null

echo ""
echo "=== 4. 重建插件（peer 依赖版本变了）==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
rm -rf node_modules dist
npm install --silent 2>&1 | tail -3
npm run build 2>&1 | tail -4

echo ""
echo "=== 5. 插件内的 cordis / dsh-tools / dsh-llm 版本 ==="
for p in cordis dsh-tools dsh-llm; do
  f="$HOME/dsh-plugins/memory-plugin/node_modules/@deepseek-ai/$p/package.json"
  if [ -f "$f" ]; then
    v=$(grep -m1 '"version"' "$f" | tr -d ' ",' | cut -d: -f2)
    echo "  $p: $v"
  else
    echo "  $p: 缺失"
  fi
done
exit 0
