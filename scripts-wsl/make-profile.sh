#!/bin/bash
# 创建 WSL 中的 dsh web profile（从默认模板）
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"

echo "=== 从默认模板创建 web profile ==="
"$DSH" --from-default-profile web --dump-config > /dev/null 2>&1
echo "exit=$?"

echo "=== profile 目录 ==="
ls -la "$HOME/.dsh/profiles/web" 2>&1

echo "=== profile cordis.yml ==="
cat "$HOME/.dsh/profiles/web/cordis.yml" 2>&1

echo "=== profile package.json ==="
cat "$HOME/.dsh/profiles/web/package.json" 2>&1

echo "=== dump-config 概要 ==="
"$DSH" --profile web --dump-config 2>&1 | head -40
