#!/bin/bash
# 在 WSL 里构建并挂载记忆插件 + 调试采集插件到 dsh web profile
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"

echo "=== 1. 复制插件到 WSL 本地（避免 /mnt/c 上的原生模块问题）==="
mkdir -p "$HOME/dsh-plugins"
for p in memory-plugin memory-debug-capture; do
  if [ -d "$REPO/$p" ]; then
    echo "--- $p ---"
    rm -rf "$HOME/dsh-plugins/$p"
    mkdir -p "$HOME/dsh-plugins/$p"
    # 只拷源码与清单，不拷 node_modules 与 data
    (cd "$REPO/$p" && tar --exclude=node_modules --exclude=data --exclude=dist -cf - .) | (cd "$HOME/dsh-plugins/$p" && tar -xf -)
  fi
done
ls -la "$HOME/dsh-plugins"

echo "=== 2. 构建 memory-plugin ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
if [ -d node_modules ]; then
  echo "已有 node_modules，跳过安装"
else
  npm install 2>&1 | tail -5
fi
npm run build 2>&1 | tail -10
echo "build exit=$?"

echo "=== 3. 构建 memory-debug-capture（若存在）==="
if [ -d "$HOME/dsh-plugins/memory-debug-capture" ]; then
  cd "$HOME/dsh-plugins/memory-debug-capture" || exit 1
  if [ ! -d node_modules ]; then
    npm install 2>&1 | tail -5
  fi
  npm run build 2>&1 | tail -10
  echo "build exit=$?"
fi

echo "=== 4. 挂载到 web profile ==="
cd "$HOME" || exit 1
for p in memory-plugin memory-debug-capture; do
  if [ -d "$HOME/dsh-plugins/$p" ]; then
    echo "--- add $p ---"
    "$DSH" plugin --profile web add "link:$HOME/dsh-plugins/$p" 2>&1 | tail -5
  fi
done

echo "=== 5. profile patch 现状 ==="
cat "$HOME/.dsh/profiles/web/cordis.patch.yml" 2>&1

echo "=== 6. 验证插件被识别 ==="
"$DSH" --profile web --dump-config 2>&1 | grep -i -A3 "memory" | head -30

echo "=== DONE ==="
exit 0
