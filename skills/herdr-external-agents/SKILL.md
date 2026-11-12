---
name: herdr-external-agents
description: 把有边界的任务派给外部编码 agent（codely / codex / 常驻 pi 会话），并取回可验收的结果。触发词：派活、worker、codely、codex、agent prompt、external_worker、只读侦察、reviewer、researcher、watchdog、worker 报告、handoff 文件、subagent tab。日常派活直接用 external_worker 工具；本 skill 只讲判断与坑（何时派、权限怎么给、结果怎么判、失败怎么归因）。本包不定义 agent 角色，角色提示词由项目或其他包提供。
---

# 外部 agent 派工：判断与坑

## When to Use

- 任务有明确边界（一个文件/一个测试/一次侦察），且值得用一个独立的 pane 跑，主会话保留决策权。
- 需要人看得见的 TUI（现场旁观、给用户演示），同时要机器可读的状态与正文。
- 需要常驻角色会话（watchdog / 长期 worker）反复 prompt。

不要用：

- 2–3 个工具调用就能做完的事 —— 直接做。
- 需要逐事件结构化流的自动化 —— Herdr 没有这个通道，只有状态 + 终端正文。

## 日常派活：`external_worker` 工具

```
external_worker({ action: "start", kind: "codely"|"codex", task, cwd, router })
external_worker({ action: "list" })
external_worker({ action: "read", pane, lines })
external_worker({ action: "prompt", pane, task })     # 追问 / 续派
external_worker({ action: "cancel", pane })
```

`start` 做的事：在 `subagent` tab 里 split 一个 pane → 起 agent → 等它被识别成 named agent →
等 TUI 画出输入框 → 送任务并确认真的开跑 → 把 pane 登记进 `~/.local/state/herdr-worker/workers.json`。
返回 `pane`、`agent`、`promptStarted`、`warnings`。

登记过的 pane 由本扩展自己收尾：`working → done|idle` 时向当前会话注入 `[worker done] …`
（`triggerTurn` 会唤醒它），随后默认关 pane；`blocked` 时注入 `[worker blocked] …` 并保留 pane；
pane 先消失则注入 `[worker gone] …` 并注销（不算成功；`cancel` 会先中止 watcher，不会走到这条）。

## 依赖（本机已满足）

| 依赖 | 为什么必须有 | 缺了会怎样 |
| --- | --- | --- |
| Herdr **fork** `vinsli/herdr`（含 `Agent::Codely`） | codely 必须被识别成 named agent，`agent prompt` 才可用 | codely 只能退回 `pane send-text`，没有 submit 顺序与 in-flight 校验 |
| Node ≥ 22（Homebrew） | 扩展随 pi 的 Node 运行；pane 里的 agent 也要它 | pane 里命中 DevEco 的 Node 18 会静默挂死 |
| （可选）`pi-intercom` | 只有 worker 需要主动回话（`send/ask`）时才用 | 不影响完成通知与自动关 pane |

## 核心事实

- Herdr 的 `agent` 子命令是本机唯一派工面：`agent start/prompt/wait/get/read/send-keys/list`。
- `codely` 已是 known agent（本机跑 fork `vinsli/herdr`），因此 codely 与 codex 一样支持 `agent prompt`。
- `agent prompt` 成功只证明文本已写入终端并回车 —— 结果必须读 pane 或 `.handoff/` 文件。
- `agent prompt` 不跟踪单 turn：提交后匹配首个 `idle|done|blocked`，两轮紧邻时可能被上一轮满足。
- 人看的 TUI 与「可被 prompt 的 agent」是同一个进程；不要为了自动化换 headless 模式。

## 角色提示词：由项目或其他包提供

本包只解决「把任务送进外部 agent 并取回结果」，**不定义角色**。角色提示词来自上层：

- 项目层：`<repo>/.pi/agents/<role>.md`（例如 hpcsharp 的 `watchdog.md`）。
- 全局角色包：`~/.pi/agent/skills/agent-roles/roles/<role>.md`（researcher / reviewer / oracle / planner / worker）。

Herdr 没有 `--system-prompt` 通道，所以：

- 一次性派活：片段正文 + 任务拼成第一条 prompt（`external_worker` 的 `task` 就是这个拼好的文本）。
- 常驻 pi 角色会话：起进程时 `pi --append-system-prompt <片段>`，之后的 prompt 只发任务。

## 权限：靠启动参数，不靠角色文字

| 意图 | codely | codex |
| --- | --- | --- |
| 只读（侦察/评审/watchdog） | `--approval-mode auto_edit --collaboration-mode ask` | `-s read-only -a never` |
| 可改文件、每条 shell 命令要批 | `--approval-mode auto_edit`（`--no-yolo`） | `-s workspace-write -a never` |
| 全自动（仅限隔离工作树） | `--approval-mode yolo` | `-s workspace-write -a never` |

`external_worker` 已经把 codely 默认设成 `yolo`（无人值守）、codex 设成 `workspace-write` + `-a never`；
要更严就自己用 `herdr pane run` 起进程，再用 `external_worker({action:"prompt"})` 对话。
pi 角色会话没有沙箱，只读靠 prompt + 不给写工具；需要硬隔离就 `git worktree` 单独开目录。

## 手写 herdr 命令的场景（工具覆盖不到时）

```bash
TAB=$(herdr tab list | jq -r '.result.tabs[]|select(.label=="subagent")|.tab_id')
ROOT=$(herdr pane list | jq -r --arg t "$TAB" '.result.panes[]|select(.tab_id==$t)|.pane_id' | head -1)
P=$(herdr pane split --pane "$ROOT" --direction down --no-focus | jq -r '.result.pane.pane_id // .result.root_pane.pane_id')
herdr pane run "$P" 'cd <repo> && PATH=/opt/homebrew/bin:$PATH codely'
herdr pane wait-output "$P" --match 'Type your message' --timeout 60000
herdr agent prompt "$P" '任务…' --wait
herdr pane read "$P" --source recent_unwrapped --lines 80
herdr pane close "$P"
```

- **`PATH=/opt/homebrew/bin:$PATH` 必给**：交互式 zsh 里 DevEco 的 Node 18 会盖住 Homebrew Node 26，codely / 任何 Node 工具会静默卡死或秒退（同一命令在非交互 shell 里正常）。
- `herdr pane move <pane> --tab <TAB> --split down` 可以把主 tab 里已在跑的 agent 原地搬进 subagent tab，进程不重启。
- `herdr tab create` 自带一个 root shell pane，worker 都 `split --pane <ROOT>`，收尾只关 worker pane，别关 root。

## Pitfalls

- **codex 目录信任弹窗会吃掉任务文本**：`external_worker` 已自动调用 `ensureCodexTrust()` 写 `~/.codex/config.toml` 的 `[projects."<canonical>"] trust_level = "trusted"`。注意：`-c 'projects."…".trust_level="trusted"'` **不能**抑制该弹窗（codex 0.167.1 实测），只有持久化配置生效；key 必须是真实路径（macOS `/tmp/x` → `/private/tmp/x`）。
- **`pane close` 也会触发一次 `idle`/`done`**：那是取消不是完成。插件 `local.worker-notify` 在推送前会用 `herdr pane get` 确认 pane 还活着，扩展 `cancelWorker` 先注销再关 pane，两边都按"pane 不在 = 取消"处理。


- **`agent prompt --wait` 假阴性**：codex 首轮可能返回 `agent_prompt_stalled`（5s 内没观察到 working），但文本已送达并执行。**不要重发**（会变成两个任务），用 `read` 复核。
- **`agent_not_ready`**：该 pane 的 agent 没被识别成 named agent —— 通常是换了 herdr 二进制但 server 没重启，或进程没起来。
- **`agent_blocked`**：它在等确认，先问用户，不要自动批准。
- **换了 herdr 二进制必须重启 server**（`herdr server stop` 再 `herdr`）；`ps -o lstart` 看 server 启动时间确认真的换了。
- **送 prompt 前必须等输入框**：codely `Type your message`、codex `Ask Codex to do anything`；没画出来就送会被 TUI 吞掉（`external_worker` 已内置这一步）。
- **codely 的完成态是 `done`**（不是 `idle`），screen agent 是 `idle`，watcher 两种都认。
- **codex 完成信号依赖 manifest 检测**：`herdr agent explain <pane>` 若显示 `manifest: remote:…/codex.toml`，说明被测试残留 manifest 污染，codex 永远报 idle；删文件 + 重启 server（见 fork `FORK.md`）。
- **别用 `pane send-text` + `send-keys Enter` 代替 prompt**：那样不享受 submit 顺序与 in-flight 校验，只在 prompt 被拒且必须硬塞时兜底。
- **`herdr api snapshot` 一次拿全量状态**（agents/tabs/panes + `agent_status`/`state_change_seq`），比逐个 `agent get` 快。

## 层间分工

| 层 | 工具 | 职责 |
| --- | --- | --- |
| 派活 / 状态 / 正文 | `external_worker` 工具（内部走 Herdr `agent *` / `pane *`） | 建 pane、起 agent、送任务、读结果、收尾 |
| 完成通知 + 自动关 pane | `external_worker` 内置 watcher（在本会话内轮询 `agent get`/`pane get`） | 起跑后 `working→idle|done` → 注入 `[worker done]` + `pane close` |
| 会话间对话 | `intercom` 工具 / `pi-intercom` CLI | 跨 harness 双向消息（ask 可等回复） |
| 结构化长结论 | `.handoff/<task>.md` | 稳定交付物，Router 以文件为准 |
| 任务状态 | Backlog CLI | 任务生命周期唯一真相 |

## Verification

1. `external_worker({action:"start"})` 返回的 `promptStarted` 为 `true`，`warnings` 为空。
2. `external_worker({action:"read"})` 里能看到开工迹象（`• Working` / `esc to interrupt`）与最终结论。
3. worker 的 `.handoff/<task>.md` 存在且三段齐全（结论 / 改动 / 证据）。
4. 干完后 pane 自动消失（`herdr pane list` 里没有该 id），并且本会话收到 `[worker done] …` 消息。
