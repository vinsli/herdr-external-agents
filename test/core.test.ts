import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  cancelWorker,
  decideWatchEvent,
  ensureCodexTrust,
  findSubagentTab,
  launchCommand,
  reapSubagentTab,
  resolveWorkspace,
  promptWithRetry,
  readRegistry,
  startWorker,
  watchWorker,
  writeRegistry,
  type Runner,
} from "../core.ts";

function freshState() {
  const dir = mkdtempSync(join(tmpdir(), "herdr-worker-test-"));
  return { dir, registry: join(dir, "workers.json") };
}

type FakeOptions = {
  agent?: string;
  statuses?: string[]; // per agent prompt call, the status observed after prompting
  seqs?: number[];
  composer?: boolean;
  registryAtLaunch?: () => unknown;
  panes?: string[];
};

function fakeHerdr(options: FakeOptions = {}) {
  const calls: string[][] = [];
  let promptIndex = 0;
  let registryAtLaunch: unknown;
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", code: 0 });
    const [group, verb, pane] = args;

    if (command !== "herdr") throw new Error(`unexpected command ${command}`);

    if (group === "tab" && verb === "list") {
      return json({ result: { tabs: [{ tab_id: "w1:t1", label: "subagents", workspace_id: "w1" }] } });
    }
    if (group === "pane" && verb === "list") {
      return json({ result: { panes: [{ pane_id: "w1:p1", tab_id: "w1:t1" }, { pane_id: "w1:p9", tab_id: "w1:t9" }] } });
    }
    if (group === "pane" && verb === "split") {
      return json({ result: { pane: { pane_id: "w1:p2" } } });
    }
    if (group === "pane" && verb === "run") {
      registryAtLaunch = options.registryAtLaunch?.();
      return json({ result: {} });
    }
    if (group === "pane" && verb === "wait-output") {
      return { stdout: "", stderr: "", code: options.composer === false ? 1 : 0 };
    }
    if (group === "pane" && verb === "read") {
      return { stdout: "  ✦ ANSWER  \n", stderr: "", code: 0 };
    }
    if (group === "pane" && verb === "close") {
      return json({ result: {} });
    }
    if (group === "agent" && verb === "list") {
      return json({
        result: {
          agents: [
            { pane_id: "w1:p2", agent: "codely", agent_status: "idle", terminal_title: "✅ Codely" },
          ],
        },
      });
    }
    if (group === "agent" && verb === "get") {
      const status = options.statuses?.[Math.min(promptIndex, (options.statuses?.length ?? 1) - 1)] ?? "idle";
      const seq = options.seqs?.[Math.min(promptIndex, (options.seqs?.length ?? 1) - 1)] ?? 0;
      return json({ result: { agent: { agent: options.agent ?? "codely", agent_status: status, completion_seq: seq } } });
    }
    if (group === "agent" && verb === "prompt") {
      promptIndex += 1;
      return json({ result: { type: "agent_prompted" } });
    }
    throw new Error(`unhandled herdr call: ${args.join(" ")}`);
  };
  return { run, calls, registryAtLaunch: () => registryAtLaunch };
}

test("launchCommand quotes cwd and keeps codely approval modes explicit", () => {
  const command = launchCommand("codely", { cwd: "/tmp/it's here", approval: "auto_edit" });
  assert.equal(command, "cd '/tmp/it'\\''s here' && PATH=/opt/homebrew/bin:$PATH codely --approval-mode auto_edit");
  assert.throws(() => launchCommand("codely", { cwd: "/tmp", approval: "sudo" }), /unsupported approval/);
});

test("launchCommand builds the codex line and rejects injected values", () => {
  const command = launchCommand("codex", { cwd: "/tmp/x", model: "gpt-6-sol", effort: "high" });
  assert.match(command, /codex -m gpt-6-sol -s workspace-write -a never -c /);
  assert.match(command, /-c model_reasoning_effort="high"$/);
  // Trust is persisted in codex's config by ensureCodexTrust; `-c` cannot suppress the
  // interactive trust prompt (verified against codex 0.167.1).
  assert.doesNotMatch(command, /trust_level/);
  assert.throws(() => launchCommand("codex", { cwd: "/tmp", model: "x; rm -rf /" }), /unsupported model/);
  assert.throws(() => launchCommand("codex", { cwd: "/tmp", effort: "high; rm" }), /unsupported reasoning effort/);
});

test("launchCommand passes codely model, effort and approval only when asked", () => {
  // Bare launch: no injected defaults at all, so the caller can report reality.
  assert.equal(launchCommand("codely", { cwd: "/tmp" }), "cd '/tmp' && PATH=/opt/homebrew/bin:$PATH codely");
  assert.equal(
    launchCommand("codely", { cwd: "/tmp", model: "claude-opus-5-5", effort: "xhigh" }),
    "cd '/tmp' && PATH=/opt/homebrew/bin:$PATH codely -m claude-opus-5-5 --reasoning_effort xhigh",
  );
  assert.equal(
    launchCommand("codely", { cwd: "/tmp", model: "codely/neo/eco/claude-opus-5-5", approval: "default" }),
    "cd '/tmp' && PATH=/opt/homebrew/bin:$PATH codely -m codely/neo/eco/claude-opus-5-5 --approval-mode default",
  );
  assert.throws(() => launchCommand("codely", { cwd: "/tmp", effort: "turbo" }), /unsupported reasoning effort/);
  assert.throws(() => launchCommand("codely", { cwd: "/tmp", model: "x; rm -rf /" }), /unsupported model/);
});

test("launchCommand passes the wire api a codely model needs", () => {
  // `neo/eco/claude-opus-5-5` is served over Anthropic messages; sending it through
  // responses is a hard 400 from the gateway, so the caller must be able to say which
  // wire protocol the backend speaks.
  assert.equal(
    launchCommand("codely", { cwd: "/tmp", model: "neo/eco/claude-opus-5-5", wireApi: "messages" }),
    "cd '/tmp' && PATH=/opt/homebrew/bin:$PATH codely -m neo/eco/claude-opus-5-5 --wire-api messages",
  );
  assert.match(
    launchCommand("codely", { cwd: "/tmp", model: "x", effort: "high", approval: "yolo", wireApi: "chat" }),
    /--approval-mode yolo --wire-api chat$/,
  );
  assert.throws(() => launchCommand("codely", { cwd: "/tmp", wireApi: "grpc" }), /unsupported wire api/);
  // codex has no wire-api switch: the flag must never leak into its line.
  assert.doesNotMatch(launchCommand("codex", { cwd: "/tmp", wireApi: "chat" }), /wire-api/);
});

test("launchCommand lets a role ask codex for a read-only sandbox", () => {
  assert.match(
    launchCommand("codex", { cwd: "/tmp", sandbox: "read-only" }),
    /-s read-only -a never/,
  );
  assert.throws(() => launchCommand("codex", { cwd: "/tmp", sandbox: "sandbox; rm" }), /unsupported sandbox/);
});

test("startWorker registers the pane before launching and reports a started turn", async () => {
  const { registry } = freshState();
  const fake = fakeHerdr({ statuses: ["idle", "idle", "working"], registryAtLaunch: () => readRegistry(registry) });
  const result = await startWorker(fake.run, {
    kind: "codely",
    task: "fix calc.py",
    cwd: "/tmp/x",
    router: "secretary",
    registry,
    retry: { attempts: 3, polls: 5, pollMs: 1, retryDelayMs: 1 },
  });

  assert.equal(result.pane, "w1:p2");
  assert.equal(result.tab, "w1:t1");
  assert.equal(result.agent, "codely");
  assert.equal(result.promptStarted, true);
  assert.deepEqual(result.warnings, []);
  // Worker was registered before `pane run`, so a fast turn cannot outrun the registry.
  assert.deepEqual(Object.keys(fake.registryAtLaunch() as object), ["w1:p2"]);
  assert.equal(readRegistry(registry)["w1:p2"]?.kind, "codely");
  assert.equal(readRegistry(registry)["w1:p2"]?.router, "secretary");
});

test("startWorker warns but keeps the pane when the task never starts a turn", async () => {
  const { registry } = freshState();
  const fake = fakeHerdr({ statuses: ["idle"], composer: false });
  const result = await startWorker(fake.run, {
    kind: "codely",
    task: "fix calc.py",
    cwd: "/tmp/x",
    registry,
    retry: { attempts: 3, polls: 3, pollMs: 1, retryDelayMs: 1 },
  });
  assert.equal(result.promptStarted, false);
  assert.equal(result.attempts, 3);
  assert.ok(result.warnings.some((w) => w.includes("never started a turn")));
  assert.ok(result.warnings.some((w) => w.includes("composer")));
  assert.equal(readRegistry(registry)["w1:p2"]?.kind, "codely");
});

test("startWorker unregisters and closes nothing when launch fails", async () => {
  const { registry } = freshState();
  const fake = fakeHerdr();
  const failing: Runner = async (command, args, options) => {
    if (args[1] === "run") throw new Error("pane run failed");
    return fake.run(command, args, options);
  };
  await assert.rejects(
    startWorker(failing, { kind: "codely", task: "t", cwd: "/tmp/x", registry }),
    /pane run failed/,
  );
  assert.deepEqual(readRegistry(registry), {});
});

test("startWorker refuses a missing subagent tab with a copy-pasteable fix", async () => {
  const run: Runner = async () => ({ stdout: JSON.stringify({ result: { tabs: [] } }), stderr: "", code: 0 });
  await assert.rejects(startWorker(run, { kind: "codely", task: "t", cwd: "/tmp/x" }), /herdr tab create --label subagent/);
});

test("promptWithRetry stops polling as soon as completion_seq advances", async () => {
  const fake = fakeHerdr({ statuses: ["idle"], seqs: [5, 6] });
  const result = await promptWithRetry(fake.run, "w1:p2", "go", { polls: 1, pollMs: 1, retryDelayMs: 1 });
  assert.equal(result.started, true);
  assert.equal(result.attempts, 1);
});

test("cancelWorker closes the pane and drops the registry entry", async () => {
  const { registry } = freshState();
  writeRegistry({ "w1:p2": { kind: "codely" } }, registry);
  const fake = fakeHerdr();
  const result = await cancelWorker(fake.run, "w1:p2", { registry });
  assert.equal(result.closed, true);
  assert.deepEqual(readRegistry(registry), {});
});

test("readRegistry tolerates a corrupt registry file", () => {
  const { dir, registry } = freshState();
  writeFileSync(registry, "{not json");
  assert.deepEqual(readRegistry(registry), {});
  writeRegistry({ "w1:p2": { kind: "codex" } }, registry);
  assert.equal(JSON.parse(readFileSync(registry, "utf8"))["w1:p2"].kind, "codex");
  assert.ok(dir);
});

test("promptWithRetry does not re-send when the screen shows a running turn", async () => {
  const { registry } = freshState();
  const calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "agent" && args[1] === "get") {
      // Detection is wrong (stale manifest): always idle, completion never moves.
      return { code: 0, stdout: JSON.stringify({ result: { agent: { agent_status: "idle", completion_seq: 7 } } }), stderr: "" };
    }
    if (args[0] === "pane" && args[1] === "read") {
      return { code: 0, stdout: "• Working (34s • esc to interrupt)", stderr: "" };
    }
    return { code: 0, stdout: "{}", stderr: "" };
  };
  const result = await promptWithRetry(run, "w2:p1", "do the thing", { attempts: 3, polls: 2, pollMs: 1, retryDelayMs: 1 });
  assert.equal(result.started, true);
  assert.equal(result.attempts, 1);
  const prompts = calls.filter((c) => c[1] === "agent" && c[2] === "prompt");
  assert.equal(prompts.length, 1, "the task must be submitted exactly once");
});

test("ensureCodexTrust writes the canonical path once and is idempotent", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-trust-"));
  const config = join(dir, "config.toml");
  writeFileSync(config, "[tui]\nnotifications = true\n", "utf8");
  const cwd = join(dir, "repo");
  mkdirSync(cwd, { recursive: true });
  const canonical = realpathSync(cwd);

  assert.equal(ensureCodexTrust(cwd, config), true);
  const first = readFileSync(config, "utf8");
  assert.ok(first.includes(`[projects.${JSON.stringify(canonical)}]`), first);
  assert.match(first, /trust_level = "trusted"/);
  assert.match(first, /\[tui\]/, "existing config survives");

  assert.equal(ensureCodexTrust(cwd, config), false, "second call is a no-op");
  assert.equal(readFileSync(config, "utf8"), first);
  rmSync(dir, { recursive: true, force: true });
});

test("ensureCodexTrust creates a missing config file", () => {
  const dir = mkdtempSync(join(tmpdir(), "herdr-trust-new-"));
  const config = join(dir, "nested", "config.toml");
  assert.equal(ensureCodexTrust(dir, config), true);
  assert.match(readFileSync(config, "utf8"), /trust_level = "trusted"/);
  rmSync(dir, { recursive: true, force: true });
});

// --- in-session completion watcher (replaces the local.worker-notify Herdr plugin) ---

test("decideWatchEvent refuses to report an unarmed idle pane as done", () => {
  // The old plugin bug: a freshly opened pane is idle before any turn starts.
  assert.equal(decideWatchEvent({ kind: "codely" }, "idle", true), null);
  assert.equal(decideWatchEvent({ kind: "codely", armed: true }, "idle", true), "done");
  assert.equal(decideWatchEvent({ kind: "codely", seen: { working: true } }, "done", true), "done");
  assert.equal(decideWatchEvent({ kind: "codely", armed: true, notified: true }, "idle", true), null);
  assert.equal(decideWatchEvent(undefined, "idle", true), null);
});

test("decideWatchEvent treats a vanished pane as gone, never as success", () => {
  assert.equal(decideWatchEvent({ kind: "codely", armed: true }, "idle", false), "pane-gone");
});

test("decideWatchEvent reports blocked once, then stops repeating", () => {
  assert.equal(decideWatchEvent({ kind: "codely", armed: true }, "blocked", true), "blocked");
  assert.equal(decideWatchEvent({ kind: "codely", armed: true, blockedNotified: true }, "blocked", true), null);
});

function fakeWatcher(statuses: string[], options: { aliveAfter?: number; title?: string } = {}) {
  let poll = 0;
  let panePoll = 0;
  const run: Runner = async (command, args) => {
    const json = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: "", code: 0 });
    const [group, verb] = args;
    if (command !== "herdr") throw new Error(`unexpected command ${command}`);
    if (group === "agent" && verb === "get") {
      const status = statuses[Math.min(poll, statuses.length - 1)];
      poll += 1;
      return json({
        result: { agent: { agent: "codely", agent_status: status, completion_seq: poll, terminal_title: options.title ?? "" } },
      });
    }
    if (group === "pane" && verb === "get") {
      const gone = options.aliveAfter !== undefined && panePoll >= options.aliveAfter;
      panePoll += 1;
      return gone ? { stdout: "", stderr: "no such pane", code: 1 } : json({ result: { pane: { pane_id: args[2] } } });
    }
    if (group === "pane" && verb === "close") return json({ result: {} });
    throw new Error(`unhandled herdr call: ${args.join(" ")}`);
  };
  return { run };
}

test("watchWorker arms on the first observed working state and reports done once", async () => {
  const { registry } = freshState();
  writeRegistry({ "w1:p2": { kind: "codely", router: "secretary", autoclose: true } }, registry);
  const fake = fakeWatcher(["working", "working", "idle"]);
  const seen: string[] = [];
  const event = await watchWorker(fake.run, "w1:p2", {
    registryFile: registry,
    pollMs: 1,
    maxPolls: 3,
    onEvent: (e) => {
      seen.push(e.kind);
    },
  });
  assert.equal(event?.kind, "done");
  assert.deepEqual(seen, ["done"]);
  const entry = readRegistry(registry)["w1:p2"];
  assert.equal(entry.seen?.working, true);
  assert.equal(entry.notified, true);
});

test("watchWorker keeps watching after blocked and reports the eventual completion", async () => {
  const { registry } = freshState();
  writeRegistry({ "w1:p2": { kind: "codely", armed: true } }, registry);
  const fake = fakeWatcher(["blocked", "working", "idle"]);
  const seen: string[] = [];
  const event = await watchWorker(fake.run, "w1:p2", {
    registryFile: registry,
    pollMs: 1,
    maxPolls: 4,
    onEvent: (e) => {
      seen.push(e.kind);
    },
  });
  assert.deepEqual(seen, ["blocked", "done"]);
  assert.equal(event?.kind, "done");
  assert.equal(readRegistry(registry)["w1:p2"].blockedNotified, true);
});

test("watchWorker reports pane-gone instead of a fake completion", async () => {
  const { registry } = freshState();
  writeRegistry({ "w1:p2": { kind: "codex", armed: true } }, registry);
  const fake = fakeWatcher(["idle", "idle"], { aliveAfter: 0 });
  const seen: string[] = [];
  const event = await watchWorker(fake.run, "w1:p2", {
    registryFile: registry,
    pollMs: 1,
    maxPolls: 2,
    onEvent: (e) => seen.push(e.kind),
  });
  assert.equal(event?.kind, "pane-gone");
  assert.deepEqual(seen, ["pane-gone"]);
});

test("watchWorker returns immediately for an unregistered pane", async () => {
  const { registry } = freshState();
  const fake = fakeWatcher(["idle"]);
  const event = await watchWorker(fake.run, "w1:p2", { registryFile: registry, pollMs: 1, maxPolls: 2 });
  assert.equal(event, null);
});

test("findSubagentTab picks the dispatching workspace's tab, not another workspace's", async () => {
  const seen: string[][] = [];
  const run: Runner = async (command, args) => {
    seen.push([command, ...args]);
    if (args[0] === "tab" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          result: {
            tabs: [
              { tab_id: "wS:t1", label: "subagents", workspace_id: "wS" },
              { tab_id: "w2:t9", label: "subagents", workspace_id: "w2" },
            ],
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return {
        stdout: JSON.stringify({ result: { panes: [{ pane_id: "w2:p9", tab_id: "w2:t9" }] } }),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };

  const found = await findSubagentTab(run, { workspace: "w2", create: true });
  assert.equal(found.tab, "w2:t9");
  assert.equal(found.root, "w2:p9");
  assert.equal(seen.some((call) => call.includes("create")), false, "must reuse the existing tab");
});

test("findSubagentTab creates the tab inside the requested workspace", async () => {
  const seen: string[][] = [];
  let created = false;
  const run: Runner = async (command, args) => {
    seen.push([command, ...args]);
    if (args[0] === "tab" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          result: { tabs: created ? [{ tab_id: "w2:t5", label: "subagents", workspace_id: "w2" }] : [] },
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "tab" && args[1] === "create") {
      created = true;
      return {
        stdout: JSON.stringify({ result: { root_pane: { pane_id: "w2:p1", tab_id: "w2:t5" } } }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "pane" && args[1] === "list") {
      return {
        stdout: JSON.stringify({ result: { panes: [{ pane_id: "w2:p1", tab_id: "w2:t5" }] } }),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };

  const found = await findSubagentTab(run, { workspace: "w2", create: true });
  assert.equal(found.created, true);
  const createCall = seen.find((call) => call.includes("create"))!;
  assert.deepEqual(createCall.slice(2), [
    "create",
    "--label",
    "subagents",
    "--no-focus",
    "--workspace",
    "w2",
  ]);
});

test("reapSubagentTab closes the tab only when no agent is left in it", async () => {
  const build = (panes: unknown[]) => {
    const calls: string[][] = [];
    const run: Runner = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "pane" && args[1] === "list") {
        return { stdout: JSON.stringify({ result: { panes } }), stderr: "", code: 0 };
      }
      if (args[0] === "tab" && args[1] === "close") {
        return { stdout: JSON.stringify({ result: {} }), stderr: "", code: 0 };
      }
      throw new Error(`unexpected ${args.join(" ")}`);
    };
    return { run, calls };
  };

  const busy = build([{ pane_id: "w1:p1", tab_id: "w1:t1" }, { pane_id: "w1:p2", tab_id: "w1:t1", agent: "codely" }]);
  assert.equal(await reapSubagentTab(busy.run, { tab: "w1:t1" }), false);
  assert.equal(busy.calls.some((call) => call.includes("close")), false);

  const idle = build([{ pane_id: "w1:p1", tab_id: "w1:t1" }]);
  assert.equal(await reapSubagentTab(idle.run, { tab: "w1:t1" }), true);
  assert.ok(idle.calls.some((call) => call.includes("close") && call.includes("w1:t1")));
});

test("resolveWorkspace follows the dispatching agent, not a fixed id", async () => {
  let calls: string[][] = [];
  const run: Runner = async (command, args) => {
    calls.push([command, ...args]);
    if (args[0] === "pane" && args[1] === "get") {
      return { stdout: JSON.stringify({ result: { pane: { pane_id: "w9:p4", workspace_id: "w9" } } }), stderr: "", code: 0 };
    }
    if (args[0] === "workspace" && args[1] === "list") {
      return {
        stdout: JSON.stringify({
          result: {
            workspaces: [
              { workspace_id: "w1", focused: false },
              { workspace_id: "w3", focused: true },
            ],
          },
        }),
        stderr: "",
        code: 0,
      };
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };

  // 1. the pane's live location wins over a stale env value (pane was moved)
  assert.equal(
    await resolveWorkspace(run, { env: { HERDR_PANE_ID: "w9:p4", HERDR_WORKSPACE_ID: "w2" } }),
    "w9",
  );

  // 2. no pane: fall back to what the process was started with
  assert.equal(await resolveWorkspace(run, { env: { HERDR_WORKSPACE_ID: "w2" } }), "w2");

  // 3. neither: the focused workspace
  calls = [];
  assert.equal(await resolveWorkspace(run, { env: {} }), "w3");
  assert.ok(calls.some((call) => call.includes("workspace")));
});
