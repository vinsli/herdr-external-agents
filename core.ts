// Core logic for the herdr-external-agents extension.
//
// Kept free of pi imports so it can be unit-tested with a fake `herdr` binary.
// The pi-facing tool lives in ./index.ts.

import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type WorkerKind = "codely" | "codex";

export type RunResult = { stdout: string; stderr: string; code: number };
export type Runner = (
  command: string,
  args: string[],
  options?: { timeout?: number; signal?: AbortSignal; cwd?: string },
) => Promise<RunResult>;

export type WorkerEntry = {
  kind: WorkerKind;
  router?: string;
  task?: string;
  autoclose?: boolean;
  cwd?: string;
  started?: string;
  seen?: { working?: boolean; blocked?: boolean; idleBeforeWork?: boolean };
  /** Set once a turn is observed to start. Only an armed worker reports completion,
   *  so a freshly opened idle pane cannot look like a finished one. */
  armed?: boolean;
  notified?: boolean;
  blockedNotified?: boolean;
};

export type Workers = Record<string, WorkerEntry>;

export const SUBAGENT_TAB_LABEL = "subagent";
export const COMPOSER_MATCH: Record<WorkerKind, string> = {
  codely: "Type your message",
  codex: "Ask Codex to do anything",
};

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.HERDR_WORKER_STATE || join(homedir(), ".local/state/herdr-worker");
}

export function registryPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(stateDir(env), "workers.json");
}

export function readRegistry(path = registryPath()): Workers {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8") || "{}") as Workers;
  } catch {
    return {};
  }
}

export function writeRegistry(workers: Workers, path = registryPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(workers, null, 2) + "\n");
  renameSync(tmp, path);
}

/** Mark a worker as dispatched: only armed workers report completion/blocked. */
export function armWorker(pane: string, path = registryPath()): void {
  const registry = readRegistry(path);
  const entry = registry[pane];
  if (!entry) return;
  entry.armed = true;
  writeRegistry(registry, path);
}

export function registerWorker(pane: string, entry: WorkerEntry, path = registryPath()): void {
  const workers = readRegistry(path);
  workers[pane] = entry;
  writeRegistry(workers, path);
}

export function unregisterWorker(pane: string, path = registryPath()): void {
  const workers = readRegistry(path);
  if (!(pane in workers)) return;
  delete workers[pane];
  writeRegistry(workers, path);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const APPROVALS = new Set(["yolo", "auto_edit", "default"]);

export function launchCommand(
  kind: WorkerKind,
  options: { cwd: string; model?: string; effort?: string; approval?: string },
): string {
  const cd = `cd ${shellQuote(options.cwd)} && PATH=/opt/homebrew/bin:$PATH `;
  if (kind === "codely") {
    const approval = options.approval ?? "yolo";
    if (!APPROVALS.has(approval)) {
      throw new Error(`unsupported approval mode "${approval}" (yolo|auto_edit|default)`);
    }
    return `${cd}codely --approval-mode ${approval}`;
  }
  if (kind === "codex") {
    const effort = options.effort ?? "high";
    if (!/^[a-z]+$/.test(effort)) {
      throw new Error(`unsupported reasoning effort "${effort}"`);
    }
    const model = options.model ?? "gpt-6-sol";
    if (!/^[A-Za-z0-9._-]+$/.test(model)) {
      throw new Error(`unsupported model "${model}"`);
    }
    return `${cd}codex -m ${model} -s workspace-write -a never -c model_reasoning_effort="${effort}"`;
  }
  throw new Error(`unsupported kind "${kind}" (codely|codex)`);
}

/**
 * Codex asks "Trust this folder?" on first use of a directory and the menu eats
 * the task text, so an unattended worker never starts. `-c
 * projects."<dir>".trust_level="trusted"` does NOT suppress it (verified against
 * codex 0.167.1); only the persisted config entry does. Write the same entry the
 * TUI would write, keyed by the canonical path ("/tmp/x" becomes
 * "/private/tmp/x" on macOS).
 */
export function ensureCodexTrust(cwd: string, configPath = join(homedir(), ".codex", "config.toml")): boolean {
  let canonical = cwd;
  try {
    canonical = realpathSync(cwd);
  } catch {
    /* keep the raw path when the directory does not exist yet */
  }
  let existing = "";
  try {
    existing = readFileSync(configPath, "utf8");
  } catch {
    existing = "";
  }
  const header = `[projects.${JSON.stringify(canonical)}]`;
  const section = existing.split(/\n(?=\[)/).find((block) => block.trimStart().startsWith(header));
  if (section && /trust_level\s*=\s*"trusted"/.test(section)) return false;
  const block = `${header}\ntrust_level = "trusted"\n`;
  const next = section
    ? existing.replace(section, `${section.trimEnd()}\n${block}`)
    : `${existing.trimEnd()}\n\n${block}`;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, next);
  return true;
}

export async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error("aborted");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

async function jsonRun(run: Runner, args: string[], options?: { timeout?: number; signal?: AbortSignal }) {
  const result = await run("herdr", args, { timeout: options?.timeout ?? 30_000, signal: options?.signal });
  const text = (result.stdout || "").trim();
  if (!text) {
    throw new Error(`herdr ${args.join(" ")} returned no output (exit ${result.code}): ${result.stderr.trim()}`);
  }
  try {
    return JSON.parse(text) as any;
  } catch {
    throw new Error(`herdr ${args.join(" ")} returned non-JSON: ${text.slice(0, 300)}`);
  }
}

export async function findSubagentTab(
  run: Runner,
  options?: { create?: boolean; label?: string; signal?: AbortSignal },
): Promise<{ tab: string; root: string; created: boolean }> {
  const label = options?.label ?? SUBAGENT_TAB_LABEL;
  const list = await jsonRun(run, ["tab", "list"], { signal: options?.signal });
  const existing = (list?.result?.tabs ?? []).find((tab: any) => tab.label === label);
  let tab: string | undefined = existing?.tab_id;
  let created = false;

  if (!tab && options?.create) {
    const made = await jsonRun(run, ["tab", "create", "--label", label, "--no-focus"], { signal: options?.signal });
    tab = made?.result?.root_pane?.tab_id ?? made?.result?.tab?.tab_id;
    created = true;
    if (!tab) {
      const again = await jsonRun(run, ["tab", "list"], { signal: options?.signal });
      tab = (again?.result?.tabs ?? []).find((t: any) => t.label === label)?.tab_id;
    }
  }
  if (!tab) {
    throw new Error(`no "${label}" tab; create it once: herdr tab create --label ${label} --no-focus`);
  }

  const panes = await jsonRun(run, ["pane", "list"], { signal: options?.signal });
  const root = (panes?.result?.panes ?? []).find((pane: any) => pane.tab_id === tab)?.pane_id;
  if (!root) throw new Error(`tab ${tab} has no pane`);
  return { tab, root, created };
}

export async function splitWorkerPane(
  run: Runner,
  options: { root: string; cwd: string; signal?: AbortSignal },
): Promise<string> {
  const made = await jsonRun(
    run,
    ["pane", "split", "--pane", options.root, "--direction", "down", "--no-focus", "--cwd", options.cwd],
    { signal: options.signal },
  );
  const pane = made?.result?.pane?.pane_id ?? made?.result?.root_pane?.pane_id;
  if (!pane) throw new Error("pane split returned no pane id");
  return pane;
}

export async function agentInfo(
  run: Runner,
  pane: string,
  signal?: AbortSignal,
): Promise<{ agent?: string | null; status?: string | null; completionSeq?: number }> {
  const got = await jsonRun(run, ["agent", "get", pane], { signal, timeout: 15_000 });
  const agent = got?.result?.agent ?? {};
  return {
    agent: agent.agent ?? null,
    status: agent.agent_status ?? null,
    completionSeq: Number(agent.completion_seq ?? 0),
  };
}

export async function waitForDetection(
  run: Runner,
  pane: string,
  options?: { attempts?: number; intervalMs?: number; signal?: AbortSignal },
): Promise<string | null> {
  const attempts = options?.attempts ?? 120;
  const interval = options?.intervalMs ?? 500;
  for (let i = 0; i < attempts; i += 1) {
    const info = await agentInfo(run, pane, options?.signal).catch(() => ({ agent: null }));
    if (info.agent) return info.agent;
    await sleep(interval, options?.signal);
  }
  return null;
}

/** Wait until the TUI has painted its composer, otherwise the pasted prompt is swallowed. */
export async function waitForComposer(
  run: Runner,
  pane: string,
  kind: WorkerKind,
  options?: { timeoutMs?: number; signal?: AbortSignal },
): Promise<boolean> {
  const match = COMPOSER_MATCH[kind];
  const result = await run(
    "herdr",
    [
      "pane",
      "wait-output",
      pane,
      "--match",
      match,
      "--source",
      "recent_unwrapped",
      "--timeout",
      String(options?.timeoutMs ?? 90_000),
    ],
    { timeout: (options?.timeoutMs ?? 90_000) + 15_000, signal: options?.signal },
  ).catch(() => ({ code: 1 } as RunResult));
  return result.code === 0;
}

/**
 * Send a prompt and wait for evidence that a turn actually started.
 * `agent prompt --wait` is unreliable (agent_prompt_stalled is a false negative),
 * so completion is detected downstream via pane.agent_status_changed events.
 */

const TURN_MARKERS = [
  /esc to interrupt/i,
  /Working \(/i,
  /Working for \d/i,
  /Thinking \(/i,
  /calculating\.\.\./i, // codely: model is producing
  /esc esc to cancel/i, // codely: a prompt/paste is in flight
  /Enter queues/i, // codely: the submitted text is queued, not idle
];

/** Screen-level proof a turn is running, used when agent_status misses it. */
export async function turnVisible(run: Runner, pane: string, signal?: AbortSignal): Promise<boolean> {
  const screen = await readPane(run, { pane, lines: 40, signal }).catch(() => "");
  return TURN_MARKERS.some((re) => re.test(screen));
}

export async function promptWithRetry(
  run: Runner,
  pane: string,
  text: string,
  options?: { attempts?: number; polls?: number; pollMs?: number; retryDelayMs?: number; signal?: AbortSignal },
): Promise<{ started: boolean; attempts: number; lastStatus?: string | null }> {
  const attempts = options?.attempts ?? 3;
  const polls = options?.polls ?? 20;
  const pollMs = options?.pollMs ?? 500;
  const base = (await agentInfo(run, pane, options?.signal).catch(() => ({ completionSeq: 0 }))).completionSeq ?? 0;

  let lastStatus: string | null | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // Never re-send into a turn that is visibly running: detection can lag or be
    // wrong (a polluted manifest left codex permanently "idle"), and re-prompting
    // then queues the same task two more times.
    if (attempt > 1 && (await turnVisible(run, pane, options?.signal))) {
      return { started: true, attempts: attempt - 1, lastStatus: lastStatus ?? "unknown" };
    }
    await run("herdr", ["agent", "prompt", pane, text], { timeout: 120_000, signal: options?.signal }).catch(
      () => undefined,
    );
    for (let i = 0; i < polls; i += 1) {
      await sleep(pollMs, options?.signal);
      const info = await agentInfo(run, pane, options?.signal).catch(() => null);
      if (info) {
        lastStatus = info.status;
        if (info.status === "working" || info.status === "blocked" || info.completionSeq > base) {
          return { started: true, attempts: attempt, lastStatus };
        }
      }
      if (await turnVisible(run, pane, options?.signal)) {
        return { started: true, attempts: attempt, lastStatus: lastStatus ?? "working" };
      }
    }
    await sleep(options?.retryDelayMs ?? 2000, options?.signal);
  }
  return { started: false, attempts, lastStatus };
}

export async function readPane(
  run: Runner,
  options: { pane: string; lines?: number; source?: string; signal?: AbortSignal },
): Promise<string> {
  const result = await run(
    "herdr",
    [
      "pane",
      "read",
      options.pane,
      "--source",
      options.source ?? "recent_unwrapped",
      "--lines",
      String(options.lines ?? 60),
    ],
    { timeout: 30_000, signal: options.signal },
  );
  return (result.stdout || "").trim() || `(pane ${options.pane} produced no output; exit ${result.code})`;
}

export async function cancelWorker(
  run: Runner,
  pane: string,
  options?: { signal?: AbortSignal; registry?: string },
): Promise<{ closed: boolean }> {
  unregisterWorker(pane, options?.registry);
  const result = await run("herdr", ["pane", "close", pane], { timeout: 30_000, signal: options?.signal }).catch(
    () => ({ code: 1 } as RunResult),
  );
  return { closed: result.code === 0 };
}

export type StartOptions = {
  kind: WorkerKind;
  task: string;
  cwd: string;
  router?: string;
  model?: string;
  effort?: string;
  approval?: string;
  autoclose?: boolean;
  keepPrompt?: boolean;
  tabLabel?: string;
  createTab?: boolean;
  registry?: string;
  signal?: AbortSignal;
  retry?: { attempts?: number; polls?: number; pollMs?: number; retryDelayMs?: number };
  onProgress?: (text: string) => void;
};

export type StartResult = {
  pane: string;
  tab: string;
  kind: WorkerKind;
  agent: string | null;
  promptStarted: boolean;
  attempts: number;
  lastStatus?: string | null;
  warnings: string[];
  command: string;
  registry: string;
};

export async function startWorker(run: Runner, options: StartOptions): Promise<StartResult> {
  const warnings: string[] = [];
  const progress = options.onProgress ?? (() => undefined);
  if (!options.task.trim()) throw new Error("task must not be empty");

  const command = launchCommand(options.kind, options);
  const { tab, root, created } = await findSubagentTab(run, {
    create: options.createTab ?? false,
    label: options.tabLabel,
    signal: options.signal,
  });
  if (created) warnings.push(`created tab "${options.tabLabel ?? SUBAGENT_TAB_LABEL}"`);

  const pane = await splitWorkerPane(run, { root, cwd: options.cwd, signal: options.signal });
  progress(`pane ${pane} in tab ${tab}`);

  const registry = options.registry ?? registryPath();
  // Register before launching: an agent can reach "done" before the first poll.
  registerWorker(
    pane,
    {
      kind: options.kind,
      router: options.router,
      task: options.task.slice(0, 200),
      autoclose: options.autoclose !== false,
      cwd: options.cwd,
      started: new Date().toISOString(),
    },
    registry,
  );

  if (options.kind === "codex") {
    try {
      if (ensureCodexTrust(options.cwd)) progress("pre-trusted cwd in codex config");
    } catch (error) {
      warnings.push(`could not pre-trust ${options.cwd} for codex: ${String((error as Error).message || error)}`);
    }
  }

  try {
    await run("herdr", ["pane", "run", pane, command], { timeout: 30_000, signal: options.signal });
    progress("launched");

    const agent = await waitForDetection(run, pane, { signal: options.signal });
    if (!agent) warnings.push(`pane ${pane} was never detected as a named agent`);
    progress(agent ? `detected ${agent}` : "not detected");

    if (agent === options.kind) {
      const ready = await waitForComposer(run, pane, options.kind, { signal: options.signal });
      if (!ready) warnings.push(`pane ${pane} did not show its composer in time`);
    }

    if (options.keepPrompt) {
      return {
        pane,
        tab,
        kind: options.kind,
        agent,
        promptStarted: false,
        attempts: 0,
        warnings,
        command,
        registry,
      };
    }

    const prompted = await promptWithRetry(run, pane, options.task, { signal: options.signal, ...options.retry });
    if (prompted.started) armWorker(pane, registry);
    else warnings.push(`prompt on ${pane} never started a turn`);
    progress(prompted.started ? "turn started" : "turn not observed");

    return {
      pane,
      tab,
      kind: options.kind,
      agent,
      promptStarted: prompted.started,
      attempts: prompted.attempts,
      lastStatus: prompted.lastStatus,
      warnings,
      command,
      registry,
    };
  } catch (error) {
    unregisterWorker(pane, registry);
    throw error;
  }
}
