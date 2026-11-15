# WSL 实测操作说明

> 目标：在 WSL 的 dsh web 上跑「启用记忆插件」与「不启用」两轮，用 `memory-debug-capture` 采集每次请求的完整上下文，
> 生成 `memory-debug.html` 做左右对比。
>
> **凭据由你自己登录。** 脚本不碰任何账号、密钥、vault。

---

## 0. 当前状态（已就绪）

| 项 | 状态 |
| --- | --- |
| WSL Ubuntu 26.04 | ✅ |
| dsh | ✅ `0.2.1-rc.5`，装在 `~/.npm-global`（用户级，无需 root） |
| web profile | ✅ `~/.dsh/profiles/web` |
| `dsh-memory-plugin` | ✅ 已挂载，激活成功 |
| `dsh-memory-debug-capture` | ✅ 已挂载，激活成功 |
| 模型凭据 | ⬜ **待你登录** |

---

## 1. 第一轮：启用插件（variant=on）

```bash
# 在 WSL 里（Windows 终端执行：wsl -d Ubuntu -- bash ...）
bash /mnt/c/Users/Assistant/projects/dsh-super-agent/scripts-wsl/start-web.sh 8085 on run-a
```

脚本会打印带 token 的 URL。然后：

1. 在浏览器打开该 URL
2. **用你自己的账号登录**（页面右下「登录」或「添加 API Key」）
3. 新建会话，工作区选 `/mnt/c/Users/Assistant/projects/dsh-super-agent`
4. **聊几轮**，让上下文涨起来（建议 ≥10 轮，或读几个大文件把上下文撑到几十万 token）
5. 停止并落盘：

```bash
bash /mnt/c/Users/Assistant/projects/dsh-super-agent/scripts-wsl/stop-web.sh
```

`stop-web.sh` 会打印本轮采集了多少条、每条的 turn/step/消息数/字符数/reasoning 字符数。

---

## 2. 第二轮：不启用插件（variant=off）

**关键**：要真的"不启用插件"，得把记忆插件从 profile 里摘掉——否则两轮都有 `memory_search` 工具，测不出差异。

```bash
# 摘掉记忆插件（只留采集插件）
cd ~/dsh-plugins
export NPM_CONFIG_PREFIX="$HOME/.npm-global"
export PATH="$HOME/.npm-global/bin:$PATH"
dsh plugin --profile web remove dsh-memory-plugin

# 起第二轮
bash /mnt/c/Users/Assistant/projects/dsh-super-agent/scripts-wsl/start-web.sh 8086 off run-b
```

用**同样的话题、同样轮数**再聊一遍（这是对比的前提）。

停止：

```bash
bash /mnt/c/Users/Assistant/projects/dsh-super-agent/scripts-wsl/stop-web.sh
```

**结束后把插件装回来**：

```bash
dsh plugin --profile web add "link:$HOME/dsh-plugins/memory-plugin"
```

---

## 3. 生成对比页

```powershell
# 在 Windows 侧
cd C:\Users\Assistant\projects\dsh-super-agent
node tools\dist\gen-memory-debug.js `
  --on captures\run-a.jsonl `
  --off captures\run-b.jsonl `
  --out memory-debug.html
```

然后浏览器打开 `memory-debug.html`。

---

## 4. 采集产物长什么样

每行一个 JSON（`captures/<runId>.jsonl`）：

```json
{
  "ts": "2026-11-15T07:40:12.123Z",
  "sessionId": "session-xxxx",
  "provider": "workbuddy",
  "model": "deepseek-v4.1-flash",
  "turn": 3, "step": 2,
  "variant": "on",
  "runId": "run-a",
  "messages": [
    { "role": "system",  "text": "...", "chars": 2273 },
    { "role": "user",    "text": "...", "chars": 56 },
    { "role": "assistant", "text": "...", "reasoning": "...", "chars": 78, "reasoningChars": 900 },
    { "role": "tool",    "toolName": "bash", "text": "...", "chars": 33333 }
  ],
  "totals": { "messages": 12, "chars": 48123, "reasoningChars": 90210, "systemChars": 2273 }
}
```

**字段说明**：

| 字段 | 含义 |
| --- | --- |
| `turn` / `step` | 轮次与步（**唯一标识一次请求**） |
| `variant` | `on` / `off`，来自环境变量 `MEMORY_DEBUG_VARIANT` |
| `messages[].reasoning` | 模型的思考内容（**独立字段**，不在 `text` 里） |
| `messages[].reasoningChars` | 思考的字符数，**不计入 `chars`** |
| `messages[].shadowed` | 该条是否已被压缩遮蔽（从压缩事件的 `shadowedSeqs` 推算） |
| `totals.chars` | 所有 `text` 之和 |
| `totals.reasoningChars` | 所有 `reasoning` 之和 |

---

## 5. HTML 会展示什么

- **左右两栏**：左=不启用插件，右=启用插件；同一 step 的气泡严格对齐（实测 maxAlignDelta = 0 px）
- **气泡 = 一次请求的上下文**，但**不做全量堆叠**：用 LCP（最长公共前缀）算出「相对上一个气泡多了什么」
  - 绿=新增、红=消失、黄=变化/增长、灰=未变
  - 折叠掉的未变前缀只显示条数与 role 分布
- **两侧 LCP 长度不同 → 整行标黄**（「LCP 与对侧差 ±N」）——这往往正是插件带来的差异
- 顶部「只看差异 / 全量」切换，默认只看差异
- 底部汇总表：逐 step 对比消息数 / 字符数 / reasoning 数 / LCP 差

---

## 6. 排查

| 现象 | 原因与处理 |
| --- | --- |
| `captures/` 是空的 | 没跑 `stop-web.sh`（SIGTERM 才会 flush）；或没有触发模型调用 |
| 页面提示「请登录」 | WSL 没有模型凭据；用你自己的账号在 UI 登录 |
| 两轮没差异 | 插件没真的摘掉，或两轮话题/轮数不同 |
| 采集文件很大 | 正常；实测 1 GB JSONL 生成 14.7 MB HTML，耗时 9.7 s |

---

## 7. 已知的坑（都已在脚本里处理）

1. **WSL 的 npm 全局目录需要 root** → 用 `NPM_CONFIG_PREFIX=$HOME/.npm-global` 用户级安装
2. **corepack 的 pnpm 缓存会坏** → 脚本用 `npm` 直接跑构建
3. **cordis 的 `ctx` 是代理** → 不能直接赋值未声明属性（`ctx.config` / `ctx.memory`），必须 `ctx.provide`，
   否则整个插件激活失败（启动日志里 `1 entry did not activate`）
4. **`link:` 是 pnpm 协议不是 Node ESM 协议** → 能工作是因为 pnpm 落成了符号链接
