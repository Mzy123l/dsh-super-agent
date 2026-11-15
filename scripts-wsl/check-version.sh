#!/bin/bash
set -u
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== WSL 里的 dsh 版本 ==="
"$HOME/.npm-global/bin/dsh" --version 2>&1 | head -2

echo ""
echo "=== 安装路径 ==="
readlink -f "$HOME/.npm-global/bin/dsh" 2>/dev/null

echo ""
echo "=== npm 包版本（权威） ==="
if [ -f "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json" ]; then
  grep -m1 '"version"' "$HOME/.npm-global/lib/node_modules/@deepseek-ai/dsh/package.json"
else
  echo "（未找到标准路径，搜索中）"
  find "$HOME/.npm-global" -path '*@deepseek-ai/dsh/package.json' -not -path '*/node_modules/*/node_modules/*' 2>/dev/null | head -3
fi

echo ""
echo "=== 是否还有其他版本残留 ==="
find "$HOME" -maxdepth 6 -path '*@deepseek-ai/dsh/package.json' -not -path '*/node_modules/*/node_modules/*' 2>/dev/null | head -5

echo ""
echo "=== 已安装的 @deepseek-ai 包版本 ==="
ls "$HOME/.npm-global/lib/node_modules/@deepseek-ai/" 2>/dev/null | head -12

echo ""
echo "=== 插件依赖的 dsh 版本 ==="
if [ -f "$HOME/dsh-plugins/memory-plugin/package.json" ]; then
  grep -A4 'peerDependencies' "$HOME/dsh-plugins/memory-plugin/package.json"
fi
