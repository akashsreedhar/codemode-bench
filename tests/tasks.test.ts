import { describe, expect, it } from "vitest";
import { runEpisode, type BackendFactory, type EpisodeSpec } from "../src/agent/episode.js";
import { CONDITION_IDS } from "../src/conditions/types.js";
import { ScriptedBackend } from "../src/llm/mock.js";
import { TASKS } from "../src/tasks/suite.js";
import { createOracleBackend } from "../src/tasks/oracle.js";
import { DEFAULT_WORLD_SEED } from "../src/world/generate.js";

const spec = (task: EpisodeSpec["task"], condition: EpisodeSpec["condition"], toolCount = 20): EpisodeSpec => ({
  task,
  condition,
  toolCount,
  seed: 1,
  maxTurns: 20,
  lenientParsing: true,
  worldSeed: DEFAULT_WORLD_SEED,
  sandbox: {},
  maxResultChars: 100_000,
});

describe("task suite", () => {
  it("has unique IDs and a pilot subset", () => {
    expect(new Set(TASKS.map((t) => t.id)).size).toBe(TASKS.length);
    expect(TASKS.length).toBe(40);
    expect(TASKS.filter((t) => t.pilot)).toHaveLength(15);
  });

  describe.each(CONDITION_IDS)("reference solutions through %s", (condition) => {
    it.each(TASKS.map((t) => [t.id, t] as const))("%s is solvable", async (_id, task) => {
      const r = await runEpisode(spec(task, condition), createOracleBackend);
      expect(r.verification?.details).toBeDefined();
      expect(r.outcome, r.verification?.details ?? r.providerError).toBe("success");
    });
  });

  // A verifier that passes without the task being done would make every result meaningless.
  it.each(TASKS.map((t) => [t.id, t] as const))("%s fails when the agent does nothing", async (_id, task) => {
    const idle: BackendFactory = () => new ScriptedBackend("idle", "idle", () => ({ content: "I have completed the task." }));
    const r = await runEpisode(spec(task, "direct"), idle);
    expect(r.outcome).toBe("failure");
  });

  it("records failure modes and error counts", async () => {
    const task = TASKS.find((t) => t.id === "lookup-customer-email")!;
    const confused: BackendFactory = () =>
      new ScriptedBackend("confused", "confused", ({ messages }) =>
        messages.length < 6 ? { toolCalls: [{ name: "crm_get_custmer", arguments: { customer_id: "C017" } }] } : { content: "unknown" },
      );
    const r = await runEpisode(spec(task, "direct"), confused);
    expect(r.outcome).toBe("failure");
    expect(r.failureMode).toBe("wrong_result");
    expect(r.errorCounts.unknown_tool).toBeGreaterThan(0);
  });

  it("stops at the turn budget", async () => {
    const task = TASKS.find((t) => t.id === "lookup-customer-email")!;
    const looping: BackendFactory = () => new ScriptedBackend("loop", "loop", () => ({ toolCalls: [{ name: "crm_get_customer", arguments: { customer_id: "C001" } }] }));
    const r = await runEpisode({ ...spec(task, "direct"), maxTurns: 3 }, looping);
    expect(r.turns).toBe(3);
    expect(r.failureMode).toBe("turn_limit");
  });

  it("stops at the per-run time limit", async () => {
    const task = TASKS.find((t) => t.id === "lookup-customer-email")!;
    const slow: BackendFactory = () =>
      new ScriptedBackend("slow", "slow", async () => {
        await new Promise((r) => setTimeout(r, 700));
        return { toolCalls: [{ name: "crm_get_customer", arguments: { customer_id: "C001" } }] };
      });
    const r = await runEpisode({ ...spec(task, "direct"), maxRunSeconds: 1 }, slow);
    expect(r.failureMode).toBe("time_limit");
    expect(r.turns).toBeLessThan(20);
  });

  it("recovers code blocks from plain-text replies when lenient parsing is on", async () => {
    const task = TASKS.find((t) => t.id === "lookup-customer-email")!;
    const textual: BackendFactory = () =>
      new ScriptedBackend("text", "text", ({ messages }) =>
        messages.some((m) => m.role === "tool")
          ? { content: messages.filter((m) => m.role === "tool").at(-1)!.content }
          : { content: 'Here is the code:\n```ts\nconst c = await codemode.crm_get_customer({ customer_id: "C017" });\nconsole.log(c.email);\n```' },
      );
    const r = await runEpisode(spec(task, "codemode"), textual);
    expect(r.recoveredFromText).toBe(1);
    expect(r.outcome).toBe("success");
    const strict = await runEpisode({ ...spec(task, "codemode"), lenientParsing: false }, textual);
    expect(strict.outcome).toBe("failure");
  });

  it("counts PII that reaches the model context", async () => {
    const task = TASKS.find((t) => t.id === "privacy-count-email-domain")!;
    const direct = await runEpisode(spec(task, "direct"), createOracleBackend);
    const code = await runEpisode(spec(task, "codemode"), createOracleBackend);
    expect(direct.piiExposed).toBeGreaterThan(code.piiExposed);
  });
});
