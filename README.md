# herdr-external-agents

Pi 扩展：用一条工具调用把外部编码 agent（`codely` / `codex`）派进 Herdr 的 `subagent` tab，
拿到可验收的结果，并在干完时收到通知、自动关 pane。

只解决**调用外部 agent**这一件事：不定义 agent 角色，也不内置任何角色提示词
（角色由项目 `.pi/agents/` 或 `~/.pi/agent/skills/agent-roles/` 提供）。

## 提供什么

| 资源 | 路径 | 说明 |
| --- | --- | --- |
| 工具 `external_worker` | `index.ts` + `core.ts` | `start` / `list` / `read` / `prompt` / `cancel` |
| 命令 `/workers` | `index.ts` | 列出当前在跑的 worker |
| skill `herdr-external-agents` | `skills/herdr-external-agents/SKILL.md` | 何时派活、权限矩阵、失败归因 |

```
external_worker({ action: "start", kind: "codely"|"codex", task, cwd, router })
external_worker({ action: "list" })
external_worker({ action: "read", pane, lines })
external_worker({ action: "prompt", pane, task })
external_worker({ action: "cancel", pane })
```

`start` 的动作顺序：在 `subagent` tab 里 split pane → 起 agent → 等它被识别成 named agent →
等 TUI 画出输入框 → 送任务并确认真的开跑 → 写进注册表 `~/.local/state/herdr-worker/workers.json`。

## 硬依赖

| 依赖 | 说明 |
| --- | --- |
| **Herdr fork** [`vinsli/herdr`](https://github.com/vinsli/herdr) | 上游 herdr 没有 `Agent::Codely`，codely 不会被识别成 named agent，`agent prompt` 会返回 `agent_not_ready`。fork 增加了 `Agent::Codely` + `manifests/codely.toml`。 |
| Node ≥ 22（Homebrew） | 扩展由 pi 自己的 Node 运行；pane 里启动 agent 时记得 `PATH=/opt/homebrew/bin:$PATH`。 |

`pi-intercom` **不是收尾依赖**：完成/阻塞通知由本扩展在派活的那个 pi 会话内完成（`pi.sendMessage`）。
只有当你希望 worker 主动回话（`pi-intercom send/ask`）时才需要它。

## 安装

```bash
# 跟随分支（有更新就能被发现）
pi install git:github.com/vinsli/herdr-external-agents@main

# 锁定到某个提交（不会自动前进，也不会检查新版本）
pi install git:github.com:vinsli/herdr-external-agents@<sha>

# 本地开发（不复制，直接加载工作区）
pi install ~/Documents/github/herdr-external-agents
```

版本变化记录在 `CHANGELOG.md`。Pi 在下次全新启动时会为「至少加载一个扩展」的包显示
“Extension Updates”（首次见到只记录版本）；平时用 `pi update --extensions` 触发拉取。
想锁死就用提交 sha 或 tag，想收到更新提示就跟随 `main` 并 bump `version` + 写 CHANGELOG。

## 开发与测试

```bash
node --test test/core.test.ts     # 19 条，注入假 Runner，不碰真实 herdr
```

`core.ts` 不 import pi，可单独测试；`index.ts` 只做协议适配（工具注册、参数校验、`pi.exec`）。

## 收尾链路（全部在扩展内，herdr 无感知）

```
external_worker  start()  ── 建 pane、派活、登记 workers.json
        │
        └─ startWatch(pane) ── 本 pi 进程每 2s 轮询 agent get + pane get
                              working → armed（只有真开过工才算数）
                              idle|done + armed → [worker done] 消息（triggerTurn 唤醒会话）
                                                    + 默认 pane close
                              blocked → [worker blocked] 消息（附批准命令，pane 保留）
                              pane 消失 → 静默注销，不报成功（取消≠完成）
```

为什么不让 herdr 做：Herdr 是通用终端宿主，不该知道 pi / pi-intercom 的存在。
「干完了」这件事由派活方（pi 会话）自己观察与处理；Herdr 只提供 `agent get` / `pane get`。

注册表仍写在 `~/.local/state/herdr-worker/workers.json`，用途变成：跨会话/重启后
`session_start` 收养遗留 worker（按 `router` 过滤），以及 `workers` 命令/`list` 展示。
