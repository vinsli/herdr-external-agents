# Changelog

## 1.1.0

收尾逻辑从 herdr 插件搬回 pi 扩展：Herdr 保持通用终端宿主，不依赖 pi / pi-intercom。

- 新增 `watchWorker()` / `decideWatchEvent()`：派活的那个 pi 会话每 2s 轮询 `herdr agent get` + `herdr pane get`。
- 完成/阻塞通过 `pi.sendMessage(..., {triggerTurn:true})` 注入本会话，**不再经过 pi-intercom**；`pi-intercom` 降为可选（`peerDependenciesMeta.optional`）。
- `pane-gone` 不再被当成完成：pane 先消失只静默注销（取消≠完成）。
- `session_start` 收养遗留 worker（按 `router` 过滤），pi 重启后仍能收到完成信号。
- `cancel` 会先中止 watcher，避免 watcher 与用户取消互相覆盖。
- 移除 `local.worker-notify` 插件（`herdr plugin uninstall local.worker-notify`）；`workers.json` 保留为跨会话收养与展示用。
- 测试 12 → 19 条（新增 `decideWatchEvent` 4 条 + `watchWorker` 4 条，均为注入假 Runner）。

## 1.0.0

首个可分发版本：从 `~/.pi/agent/extensions/` 本地目录整理成独立 pi 包。

- 工具 `external_worker`（`start|list|read|prompt|cancel`）+ 命令 `/workers`。
- skill `herdr-external-agents` 随包分发（`pi.skills`），不再依赖 `resources_discover`。
- 收尾契约：写 `~/.local/state/herdr-worker/workers.json`，由 herdr 插件 `local.worker-notify` 消费。
- 起跑确认：`armed` 注册 + 屏幕证据（`TURN_MARKERS`，含 codely 的 `calculating...` / `esc esc to cancel` / `Enter queues`），在跑绝不重发。
- codex 目录信任：`ensureCodexTrust()` 直接写 `~/.codex/config.toml`（`-c projects.…trust_level` 实测无效）。
- `cancelWorker` 先注销再关 pane；插件用 `pane get` 区分「取消」与「完成」。
- 移除内置角色：角色提示词改由项目 `.pi/agents/` 或 `agent-roles` 包提供。
- 自动关 pane 默认开启（`noClose` 可关）。
