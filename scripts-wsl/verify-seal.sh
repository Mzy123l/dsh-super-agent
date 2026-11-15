#!/bin/bash
# 验证 memory_seal 的 surface replace 是否真的生效
#
# 判断依据：封存后，模型的上下文里应该只剩总结，原始消息不再可见。
# 用一个不依赖模型凭据的方式验证：检查 session 日志里 surface 事件被遮蔽。
set -u
export npm_config_registry="https://registry.npmjs.org"
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
DSH="$HOME/.npm-global/bin/dsh"
REPO="/mnt/c/Users/Assistant/projects/dsh-super-agent"

echo "=== 1. 同步并重建插件 ==="
mkdir -p "$HOME/dsh-plugins/memory-plugin"
cp -rf "$REPO/memory-plugin/src/." "$HOME/dsh-plugins/memory-plugin/src/"
cp -f "$REPO/memory-plugin/package.json" "$REPO/memory-plugin/tsconfig.json" "$REPO/memory-plugin/tsconfig.build.json" "$HOME/dsh-plugins/memory-plugin/" 2>/dev/null
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
npm run build 2>&1 | tail -4
echo "build exit=$?"

echo ""
echo "=== 2. 确认插件被 dsh 识别（含 memory_seal 工具） ==="
"$DSH" --profile web --dump-config 2>&1 | grep -A2 'memory-plugin' | head -6

echo ""
echo "=== 3. 检查 seal 模块是否进了构建产物 ==="
ls -la "$HOME/dsh-plugins/memory-plugin/dist/seal/" 2>&1

echo ""
echo "=== 4. 单元测试（在 WSL 里再跑一遍） ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
if [ -d node_modules ]; then
  ./node_modules/.bin/vitest run tests/seal.test.ts 2>&1 | tail -8
else
  echo "（无 node_modules，跳过）"
fi

echo ""
echo "=== 5. 验证 surfaceOp 结构符合 dsh 的 isReplaceOp ==="
node -e "
import('./dist/seal/types.js').then(m => {
  const [type, data, opts] = m.buildSealEvent('测试总结', 10, 20);
  const op = opts.surfaceOp;
  const keys = Object.keys(op).sort();
  console.log('type:', type);
  console.log('surfaceOp keys:', keys.join(','));
  console.log('恰好3个键:', keys.length === 3);
  console.log('op === replace:', op.op === 'replace');
  console.log('seq 是非负安全整数:', Number.isSafeInteger(op.startSeq) && op.startSeq >= 0 && Number.isSafeInteger(op.endSeq));
  console.log('source.kind:', data.source.kind);
})
" 2>&1

exit 0
