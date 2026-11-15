#!/bin/bash
set -u
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"

echo "=== npm 上 @deepseek-ai/dsh 的可用版本 ==="
npm view @deepseek-ai/dsh versions --json 2>&1 | tail -20

echo ""
echo "=== 最新版本（含 prerelease）==="
npm view @deepseek-ai/dsh version 2>&1 | head -2

echo ""
echo "=== dist-tags ==="
npm view @deepseek-ai/dsh dist-tags --json 2>&1 | head -20
