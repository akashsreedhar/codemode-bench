import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { runEpisode, type EpisodeResult } from "../agent/episode.js";
import type { ConditionId } from "../conditions/types.js";
import { ResponseCache, createBackend, type LLMBackend, type ModelConfig, type ModelInfo } from "../llm/index.js";
import { selectTasks } from "../tasks/suite.js";
import { createOracleBackend } from "../tasks/oracle.js";
import type { TaskDefinition } from "../tasks/types.js";
import type { ExperimentConfig } from "./config.js";
import { gitInfo, hardwareInfo, harnessVersion, taskSetHash, type GitInfo, type HardwareInfo } from "./metadata.js";

export const RESULT_SCHEMA_VERSION = 1;

/** One line of results/<experiment>/runs.jsonl. */
export interface RunRecord {
  schemaVersion: number;
  runId: string;
  experiment: string;
  taskId: string;
  category: string;
  chain: string;
  payload: string;
  condition: ConditionId;
  modelId: string;
  provider: string;
  model: string;
  toolCount: number;
  exposedTools: number;
  seed: number;
  worldSeed: number;
  outcome: EpisodeResult["outcome"];
  failureMode: string | null;
  score: number;
  verification: string;
  answer: string;
  turns: number;
  toolCallsEmitted: number;
  mcpCalls: number;
  distractorCalls: number;
  errorCounts: Record<string, number>;
  recoveredFromText: number;
  promptTokens: number;
  completionTokens: number;
  promptChars: number;
  maxPromptChars: number;
  firstTurnPromptChars: number;
  contextSaturated: boolean;
  llmLatencyMs: number;
  wallMs: number;
  cachedResponses: number;
  piiExposed: number;
  truncatedResults: number;
  providerError: string | null;
  sampling: { temperature?: number; topP?: number; contextWindow?: number; maxTokens?: number; think?: boolean; maxTurns: number; maxRunSeconds: number; lenientParsing: boolean };
  modelInfo: ModelInfo;
  hardware: HardwareInfo;
  git: GitInfo;
  harnessVersion: string;
  taskSetHash: string;
  startedAt: string;
}

interface PlannedRun {
  runId: string;
  task: TaskDefinition<any>;
  condition: ConditionId;
  model: ModelConfig;
  toolCount: number;
  seed: number;
}

export interface BenchOptions {
  /** Run only the first N pending runs. */
  limit?: number;
  /** Run shard i of n (1-based), e.g. "2/4", to split work across machines. */
  shard?: string;
  /** Only run these model IDs. */
  models?: string[];
  dryRun?: boolean;
  /** Override the output directory. */
  output?: string;
  log?: (line: string) => void;
}

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export function planRuns(config: ExperimentConfig, hash: string): PlannedRun[] {
  const out: PlannedRun[] = [];
  const seen = new Set<string>();
  for (const grid of config.grids) {
    const models = config.models.filter((m) => !grid.models || grid.models.includes(m.id));
    for (const model of models)
      for (const toolCount of grid.toolCounts)
        for (const condition of grid.conditions)
          for (const task of selectTasks(grid.tasks))
            for (const seed of grid.seeds) {
              const runId = sha([config.name, task.id, condition, model.id, model.model, toolCount, seed, config.worldSeed, hash].join("|")).slice(0, 16);
              if (seen.has(runId)) continue;
              seen.add(runId);
              out.push({ runId, task, condition, model, toolCount, seed });
            }
  }
  return out;
}

async function completedRunIds(file: string): Promise<Set<string>> {
  if (!existsSync(file)) return new Set();
  const done = new Set<string>();
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as RunRecord;
      if (r.outcome !== "error") done.add(r.runId);
    } catch {
      // ignore a partially written trailing line
    }
  }
  return done;
}

function parseShard(shard?: string): [number, number] | undefined {
  if (!shard) return undefined;
  const m = shard.match(/^(\d+)\/(\d+)$/);
  if (!m || Number(m[1]) < 1 || Number(m[1]) > Number(m[2])) throw new Error(`Invalid --shard '${shard}', expected i/n`);
  return [Number(m[1]), Number(m[2])];
}

const fmtK = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export async function runBenchmark(config: ExperimentConfig, opts: BenchOptions = {}): Promise<{ planned: number; executed: number; outputDir: string }> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const outputDir = opts.output ?? config.output ?? join("results", config.name);
  const runsFile = join(outputDir, "runs.jsonl");
  const hash = taskSetHash(config.worldSeed);

  let runs = planRuns(config, hash);
  if (opts.models?.length) runs = runs.filter((r) => opts.models!.includes(r.model.id));
  const shard = parseShard(opts.shard);
  if (shard) runs = runs.filter((_, i) => i % shard[1] === shard[0] - 1);
  const planned = runs.length;
  const done = await completedRunIds(runsFile);
  runs = runs.filter((r) => !done.has(r.runId));
  const alreadyComplete = planned - runs.length;
  if (opts.limit !== undefined) runs = runs.slice(0, opts.limit);

  log(`Experiment "${config.name}": ${planned} runs planned, ${alreadyComplete} already complete, ${runs.length} to execute.`);
  if (opts.dryRun || runs.length === 0) return { planned, executed: 0, outputDir };

  const cache = config.cache ? new ResponseCache(join(".cache", "llm")) : undefined;
  const hardware = hardwareInfo();
  const git = gitInfo();
  const version = harnessVersion();

  // Real backends are created once per model and checked before any run starts.
  const backends = new Map<string, LLMBackend>();
  const infos = new Map<string, ModelInfo>();
  for (const model of new Map(runs.map((r) => [r.model.id, r.model])).values()) {
    if (model.provider === "mock") {
      infos.set(model.id, { provider: "mock", model: model.model });
      continue;
    }
    const backend = createBackend(model, cache);
    infos.set(model.id, await backend.describe());
    backends.set(model.id, backend);
  }

  await mkdir(join(outputDir, "traces"), { recursive: true });
  await writeFile(
    join(outputDir, "manifest.json"),
    JSON.stringify({ experiment: config.name, description: config.description, config, taskSetHash: hash, harnessVersion: version, hardware, git, models: Object.fromEntries(infos), updatedAt: new Date().toISOString() }, null, 2),
  );

  let executed = 0;
  for (const run of runs) {
    const startedAt = new Date().toISOString();
    const result = await runEpisode(
      {
        task: run.task,
        condition: run.condition,
        toolCount: run.toolCount,
        seed: run.seed,
        maxTurns: config.maxTurns,
        lenientParsing: config.lenientParsing,
        worldSeed: config.worldSeed,
        contextWindow: run.model.contextWindow,
        sandbox: { timeoutMs: config.sandbox.timeoutMs, memoryLimitBytes: config.sandbox.memoryLimitMb * 1024 * 1024, maxHostCalls: config.sandbox.maxHostCalls },
        maxResultChars: config.maxResultChars,
        maxRunSeconds: config.maxRunSeconds,
      },
      run.model.provider === "mock" ? createOracleBackend : () => backends.get(run.model.id)!,
    );
    const record: RunRecord = {
      schemaVersion: RESULT_SCHEMA_VERSION,
      runId: run.runId,
      experiment: config.name,
      taskId: run.task.id,
      category: run.task.category,
      chain: run.task.chain,
      payload: run.task.payload,
      condition: run.condition,
      modelId: run.model.id,
      provider: run.model.provider,
      model: run.model.model,
      toolCount: run.toolCount,
      exposedTools: result.exposedTools,
      seed: run.seed,
      worldSeed: config.worldSeed,
      outcome: result.outcome,
      failureMode: result.failureMode ?? null,
      score: result.verification?.score ?? 0,
      verification: result.verification?.details ?? "",
      answer: result.answer.slice(0, 2000),
      turns: result.turns,
      toolCallsEmitted: result.toolCallsEmitted,
      mcpCalls: result.mcpCalls,
      distractorCalls: result.distractorCalls,
      errorCounts: result.errorCounts as Record<string, number>,
      recoveredFromText: result.recoveredFromText,
      promptTokens: result.usage.promptTokens,
      completionTokens: result.usage.completionTokens,
      promptChars: result.promptChars.total,
      maxPromptChars: result.promptChars.max,
      firstTurnPromptChars: result.promptChars.firstTurn,
      contextSaturated: result.contextSaturated,
      llmLatencyMs: result.llmLatencyMs,
      wallMs: result.wallMs,
      cachedResponses: result.cachedResponses,
      piiExposed: result.piiExposed,
      truncatedResults: result.truncatedResults,
      providerError: result.providerError ?? null,
      sampling: {
        temperature: run.model.temperature,
        topP: run.model.topP,
        contextWindow: run.model.contextWindow,
        maxTokens: run.model.maxTokens,
        think: run.model.think,
        maxTurns: config.maxTurns,
        maxRunSeconds: config.maxRunSeconds,
        lenientParsing: config.lenientParsing,
      },
      modelInfo: infos.get(run.model.id)!,
      hardware,
      git,
      harnessVersion: version,
      taskSetHash: hash,
      startedAt,
    };
    await appendFile(runsFile, JSON.stringify(record) + "\n");
    await writeFile(
      join(outputDir, "traces", `${run.runId}.json.gz`),
      gzipSync(JSON.stringify({ runId: run.runId, task: run.task.id, condition: run.condition, model: run.model.id, toolCount: run.toolCount, seed: run.seed, messages: result.messages, turns: result.turnLog })),
    );
    executed++;
    const status = result.outcome === "success" ? "✓ success" : result.outcome === "error" ? `! error: ${result.providerError?.slice(0, 120)}` : `✗ ${result.failureMode}`;
    log(
      `[${executed}/${runs.length}] ${run.model.id} · ${run.condition} · tools=${run.toolCount} · seed=${run.seed} · ${run.task.id} → ${status} ` +
        `(${result.turns} turns, ${fmtK(result.usage.promptTokens + result.usage.completionTokens)} tok, ${(result.wallMs / 1000).toFixed(1)}s)`,
    );
  }
  return { planned, executed, outputDir };
}
