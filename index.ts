import { type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { readFile } from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  agentInfo,
  cancelWorker,
  readPane,
  readRegistry,
  reapSubagentTab,
  registryPath,
  promptWithRetry,
  startWorker,
  stateDir,
  unregisterWorker,
  watchWorker,
  type RunResult,
  type Runner,
  type WatchEvent,
  type WorkerKind,
} from "./core.ts";

// Intercom fallback alias mirrors pi-intercom so a completion push reaches this
// session even when it has no explicit name.
function routerName(pi: ExtensionAPI, sessionId: string | undefined): string | undefined {
  const named = pi.getSessionName()?.trim();
  if (named) return named;
  if (!sessionId) return undefined;
  const normalized = sessionId.startsWith("session-") ? sessionId.slice("session-".length) : sessionId;
  return `subagent-chat-${normalized.slice(0, 18)}`;
}

const KIND = StringEnum(["codely", "codex"] as const);

export default function herdrExternalAgents(pi: ExtensionAPI) {
  const watchers = new Map<string, AbortController>();

  /** Append-only trace: who started, who finished, who closed the pane, who vanished. */
  /** The tab belongs to the workspace the dispatcher runs in, so workers of `w2` stay in `w2`. */
  function currentWorkspace(): string | undefined {
    return process.env.HERDR_WORKSPACE_ID || undefined;
  }

  /**
   * Reap the shared `subagents` tab once its last worker is gone: the tab exists only
   * while workers do, so it must not outlive them as an empty shell.
   */
  async function reapTab(pane: string, tab: string | undefined) {
    if (!tab) return;
    const remaining = Object.entries(readRegistry()).some(([other, entry]) => entry.tab === tab && other !== pane);
    if (remaining) return;
    const reaped = await reapSubagentTab(run, { tab }).catch(() => false);
    if (reaped) logEvent({ pane, event: "tab-reaped", tab });
  }

  function logEvent(entry: Record<string, unknown>) {
    try {
      appendFileSync(`${stateDir()}/events.log`, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`);
    } catch {
      // tracing must never break a dispatch
    }
  }

  const run: Runner = async (command, args, options): Promise<RunResult> => {
    const result = await pi.exec(command, args, {
      timeout: options?.timeout ?? 60_000,
      cwd: options?.cwd,
      signal: options?.signal,
    });
    return { stdout: result.stdout, stderr: result.stderr, code: result.code };
  };

  /**
   * The dispatcher owns the completion signal: Herdr only reports pane status,
   * this session turns it into a message + pane close. Nothing outside pi
   * (no Herdr plugin) needs to know that pi-intercom or pi exist at all.
   */
  function startWatch(pane: string, options: { autoclose?: boolean } = {}) {
    watchers.get(pane)?.abort();
    const controller = new AbortController();
    watchers.set(pane, controller);

    void watchWorker(run, pane, {
      signal: controller.signal,
      onEvent: async (event: WatchEvent) => {
        const label =
          event.kind === "done" ? `[worker done] ${pane}` : event.kind === "blocked" ? `[worker blocked] ${pane}` : `[worker gone] ${pane}`;
        const detail =
          event.kind === "done"
            ? `status=${event.status}${event.title ? ` title="${event.title}"` : ""}`
            : event.kind === "blocked"
              ? `approve with: herdr pane send-keys ${pane} Enter`
              : "pane disappeared before reporting completion (crashed, or closed elsewhere); not counted as success";

        if (event.kind === "pane-gone") {
          // Cancel aborts the watcher first, so a pane-gone observed here means the worker
          // died or someone else closed it: report it, but never claim success.
          const goneTab = readRegistry()[pane]?.tab;
          unregisterWorker(pane);
          watchers.delete(pane);
          controller.abort();
          logEvent({ pane, event: "pane-gone" });
          void reapTab(pane, goneTab);
        }

        if (event.kind === "done") {
          const doneTab = readRegistry()[pane]?.tab;
          logEvent({ pane, event: "done", status: event.status, closed: options.autoclose !== false });
          if (options.autoclose !== false) await cancelWorker(run, pane).catch(() => undefined);
          watchers.delete(pane);
          controller.abort();
          if (options.autoclose !== false) void reapTab(pane, doneTab);
        }
        // blocked is not terminal: keep watching so the approval still ends with [worker done].

        pi.sendMessage(
          { customType: "herdr-worker", content: `${label} ${detail}`, display: true },
          { deliverAs: "followUp", triggerTurn: true },
        );
      },
    }).catch(() => {
      watchers.delete(pane);
    });
  }

  pi.on("session_start", async (_event, ctx) => {
    // Adopt workers left registered by an earlier session of this router.
    const me = routerName(pi, ctx.sessionManager?.getSessionId?.());
    for (const [pane, entry] of Object.entries(readRegistry())) {
      if (entry.router && me && entry.router !== me) continue;
      if (watchers.has(pane)) continue;
      startWatch(pane, { autoclose: entry.autoclose });
    }
  });

  pi.on("session_shutdown", async () => {
    for (const controller of watchers.values()) controller.abort();
    watchers.clear();
  });

  pi.registerTool({
    name: "external_worker",
    label: "External Worker",
    description:
      "Run an external coding agent (codely or codex) in a pane inside the Herdr `subagent` tab, prompt it, read it, and cancel it. " +
      "This session watches the pane itself: on completion it injects a [worker done] message and closes the pane unless noClose is set.",
    promptSnippet:
      "external_worker: start/list/read/prompt/cancel external codely or codex workers in the Herdr subagent tab",
    promptGuidelines: [
      "Use external_worker instead of spawning codely or codex by hand with `herdr pane` commands; it registers the pane, notifies this session when the worker finishes, and closes the pane.",
      "Use external_worker({action:'read'}) to read a worker's pane before cancelling or re-prompting it.",
      "external_worker action:'start' returns promptStarted:false with warnings when the turn never started; read the pane before retrying, because re-sending a task can duplicate work.",
    ],
    parameters: Type.Object({
      action: StringEnum(["start", "list", "read", "prompt", "cancel"] as const),
      kind: Type.Optional(KIND),
      task: Type.Optional(Type.String({ description: "Task text for action:'start' or follow-up for action:'prompt'" })),
      taskFile: Type.Optional(Type.String({ description: "Read the task text from this file (alternative to task)" })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the worker (default: session cwd)" })),
      router: Type.Optional(
        Type.String({ description: "pi-intercom session to notify on completion (default: this session)" }),
      ),
      model: Type.Optional(Type.String({ description: "codex model (default gpt-6-sol)" })),
      effort: Type.Optional(Type.String({ description: "codex reasoning effort (default high)" })),
      approval: Type.Optional(
        Type.String({ description: "codely approval mode: yolo (default) | auto_edit | default" }),
      ),
      noClose: Type.Optional(Type.Boolean({ description: "Keep the pane open after the worker finishes" })),
      keepPrompt: Type.Optional(Type.Boolean({ description: "Launch the agent but do not send a task yet" })),
      createTab: Type.Optional(Type.Boolean({ description: "Create the subagent tab when it is missing" })),
      pane: Type.Optional(Type.String({ description: "Target pane for read/prompt/cancel" })),
      lines: Type.Optional(Type.Number({ description: "Lines to read for action:'read' (default 60)" })),
      source: Type.Optional(
        Type.String({ description: "Herdr read source for action:'read' (default recent_unwrapped)" }),
      ),
    }),
    async execute(toolCallId, params, signal, onUpdate, ctx) {
      const requirePane = () => {
        if (!params.pane) throw new Error(`action:'${params.action}' needs pane`);
        return params.pane;
      };

      if (params.action === "list") {
        const registry = readRegistry();
        const agents = await run("herdr", ["agent", "list"], { timeout: 20_000, signal }).catch(() => null);
        let live = "";
        if (agents?.code === 0) {
          try {
            const parsed = JSON.parse(agents.stdout);
            const rows = (parsed?.result?.agents ?? []).map(
              (agent: any) =>
                `${agent.pane_id}\t${agent.agent ?? "-"}\t${agent.agent_status ?? "-"}\t${agent.terminal_title ?? ""}`,
            );
            live = rows.join("\n");
          } catch {
            live = agents.stdout.trim();
          }
        }
        const registered = Object.entries(registry)
          .map(([pane, entry]) => `${pane}\t${entry.kind}\trouter=${entry.router ?? "-"}\tautoclose=${entry.autoclose !== false}`)
          .join("\n");
        return {
          content: [
            {
              type: "text",
              text: [
                "## live agents",
                live || "(none)",
                "",
                "## registered workers",
                registered || "(none)",
                "",
                `registry: ${registryPath()}`,
              ].join("\n"),
            },
          ],
          details: { agents: live, registry },
        };
      }

      if (params.action === "read") {
        const pane = requirePane();
        const text = await readPane(run, { pane, lines: params.lines, source: params.source, signal });
        return { content: [{ type: "text", text }], details: { pane } };
      }

      if (params.action === "prompt") {
        const pane = requirePane();
        let text = params.task ?? "";
        if (params.taskFile) text = await readFile(resolve(ctx.cwd, params.taskFile), "utf8");
        if (!text.trim()) throw new Error("action:'prompt' needs task or taskFile");
        const info = await agentInfo(run, pane, signal).catch(() => null);
        const result = await promptWithRetry(run, pane, text, { signal });
        return {
          content: [
            {
              type: "text",
              text: `prompted ${pane} (agent=${info?.agent ?? "?"} status=${info?.status ?? "?"}) started=${result.started} attempts=${result.attempts}`,
            },
          ],
          details: { pane, ...result },
        };
      }

      if (params.action === "cancel") {
        const pane = requirePane();
        watchers.get(pane)?.abort();
        watchers.delete(pane);
        const cancelledTab = readRegistry()[pane]?.tab;
        logEvent({ pane, event: "cancelled" });
        const result = await cancelWorker(run, pane, { signal });
        await reapTab(pane, cancelledTab);
        return {
          content: [{ type: "text", text: `closed ${pane} (closed=${result.closed})` }],
          details: { pane, ...result },
        };
      }

      // action: start
      if (!params.kind) throw new Error("action:'start' needs kind (codely|codex)");
      let task = params.task ?? "";
      if (params.taskFile) task = await readFile(resolve(ctx.cwd, params.taskFile), "utf8");
      if (!task.trim() && !params.keepPrompt) throw new Error("action:'start' needs task or taskFile");

      const cwd = resolve(ctx.cwd, params.cwd ?? ".");
      const router = params.router ?? routerName(pi, ctx.sessionManager?.getSessionId?.());
      const result = await startWorker(run, {
        kind: params.kind as WorkerKind,
        task,
        cwd,
        router,
        model: params.model,
        effort: params.effort,
        approval: params.approval,
        autoclose: params.noClose ? false : true,
        keepPrompt: params.keepPrompt,
        createTab: params.createTab,
        workspace: currentWorkspace(),
        signal,
        onProgress: (text) => onUpdate?.({ content: [{ type: "text", text }], details: {} }),
      });

      const lines = [
        `pane: ${result.pane} (tab ${result.tab})`,
        `kind: ${result.kind}  agent: ${result.agent ?? "not detected"}`,
        `promptStarted: ${result.promptStarted}  attempts: ${result.attempts}` +
          (result.lastStatus ? `  lastStatus: ${result.lastStatus}` : ""),
        `autoclose: ${params.noClose ? false : true}`,
        result.warnings.length ? `warnings: ${result.warnings.join(" | ")}` : "",
        "",
        `read: external_worker({ action: "read", pane: "${result.pane}" })`,
      ].filter(Boolean);
      logEvent({
        pane: result.pane,
        event: "started",
        kind: result.kind,
        cwd,
        model: params.model ?? null,
        promptStarted: result.promptStarted,
      });
      startWatch(result.pane, { autoclose: params.noClose ? false : true });
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        details: { ...result, router },
      };
    },
  });

  pi.registerCommand("workers", {
    description: "List external workers (live agents + registry)",
    handler: async (_args, ctx) => {
      const registry = readRegistry();
      const entries = Object.entries(registry);
      ctx.ui.notify(
        entries.length
          ? entries.map(([pane, entry]) => `${pane} ${entry.kind} router=${entry.router ?? "-"}`).join("\n")
          : "no registered workers",
        "info",
      );
    },
  });
}

