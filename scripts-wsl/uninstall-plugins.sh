#!/bin/bash
# 从 WSL 的 dsh profile 里彻底卸载本仓库的两个插件。
# 用户明确要求：不要在当前设备上装这个插件。
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== 卸载前的 bundle 列表 ==="
grep -A8 '"bundles"' "$HOME/.dsh/profiles/web/package.json" 2>/dev/null

echo ""
echo "=== 卸载 memory-plugin ==="
"$DSH" plugin --profile web remove dsh-memory-plugin 2>&1 | tail -4

echo ""
echo "=== 卸载 memory-debug-capture ==="
"$DSH" plugin --profile web remove dsh-memory-debug-capture 2>&1 | tail -4

echo ""
echo "=== 卸载后的 package.json ==="
cat "$HOME/.dsh/profiles/web/package.json" 2>/dev/null

echo ""
echo "=== 卸载后的 cordis.patch.yml ==="
cat "$HOME/.dsh/profiles/web/cordis.patch.yml" 2>/dev/null

echo ""
echo "=== 删除插件构建目录 ==="
rm -rf "$HOME/dsh-plugins"
ls -d "$HOME/dsh-plugins" 2>/dev/null && echo "仍存在" || echo "已删除 ~/dsh-plugins"

exit 0
