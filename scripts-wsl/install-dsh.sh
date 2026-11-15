#!/bin/bash
# 在 WSL Ubuntu 中安装 dsh（用户级，无需 root）
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
mkdir -p "$HOME/.npm-global"

echo "=== node/npm ==="
node -v
npm -v

echo "=== 安装 dsh ==="
cd "$HOME" || exit 1
if ! timeout 420 npm install -g @deepseek-ai/dsh@0.2.1-rc.5 2>&1 | tail -12; then
  echo "INSTALL_FAILED"
  exit 1
fi

echo "=== bin ==="
ls -la "$HOME/.npm-global/bin" 2>&1

echo "=== dsh --version ==="
"$HOME/.npm-global/bin/dsh" --version 2>&1 | head -3
echo "=== dsh --help ==="
"$HOME/.npm-global/bin/dsh" --help 2>&1 | head -25
