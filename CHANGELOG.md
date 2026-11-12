# Changelog

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
