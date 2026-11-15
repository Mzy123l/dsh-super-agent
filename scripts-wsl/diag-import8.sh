#!/bin/bash
set -u
echo "=== 插件自己的 node_modules ==="
ls "$HOME/dsh-plugins/memory-plugin/node_modules/@deepseek-ai/" 2>/dev/null || echo "（无 @deepseek-ai 目录）"
echo ""
echo "=== 插件内解析各 peer ==="
cd "$HOME/dsh-plugins/memory-plugin" || exit 1
for pkg in '@deepseek-ai/cordis' '@deepseek-ai/dsh-tools' '@deepseek-ai/dsh-llm' '@deepseek-ai/dsh-attachment'; do
  node -e "import('$pkg').then(()=>console.log('$pkg OK')).catch(e=>console.error('$pkg FAIL:', e.message.split('\n')[0]))" 2>&1 | head -2
done
echo ""
echo "=== profile 里 @deepseek-ai 的实际内容 ==="
ls "$HOME/.dsh/profiles/web/node_modules/@deepseek-ai/" 2>/dev/null || echo "（profile 无 @deepseek-ai）"
echo ""
echo "=== dsh 本体在哪、它有没有这些包 ==="
which dsh
DSHDIR=$(dirname $(readlink -f $(which dsh)))
echo "dsh bin dir: $DSHDIR"
ls "$(dirname "$DSHDIR")/node_modules/@deepseek-ai/" 2>/dev/null | head -8 || echo "（上层无 node_modules）"
exit 0
