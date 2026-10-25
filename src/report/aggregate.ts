import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunRecord } from "../bench/run.js";
import { CONDITION_IDS, type ConditionId } from "../conditions/types.js";
import { groupBy, mcnemarExact, mean, median, wilson } from "./stats.js";

export interface CellStats {
  modelId: string;
  condition: ConditionId;
  toolCount?: number;
  n: number;
  successes: number;
  successRate: number;
  ci95: [number, number];
  meanScore: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  meanPromptChars: number;
  meanTurns: number;
  meanMcpCalls: number;
  medianWallSeconds: number;
  meanPiiExposed: number;
  contextSaturatedRate: number;
}

export interface PairedComparison {
  modelId: string;
  toolCount: number;
  baseline: ConditionId;
  treatment: ConditionId;
  pairs: number;
  baselineRate: number;
  treatmentRate: number;
  delta: number;
  onlyBaseline: number;
  onlyTreatment: number;
  pValue: number;
}

export interface ModelSummary {
  modelId: string;
  provider: string;
  model: string;
  digest?: string;
  parameterSize?: string;
  quantization?: string;
  contextWindow?: number;
  temperature?: number;
  topP?: number;
}

export interface ReportData {
  generatedFrom: { files: string[]; rows: number; includedRows: number; excluded: Record<string, number> };
  taskSetHash: string | null;
  harnessVersions: string[];
  gitCommits: string[];
  dateRange: [string, string] | null;
  hardware: string[];
  models: ModelSummary[];
  conditions: ConditionId[];
  toolCounts: number[];
  overall: CellStats[];
  byToolCount: CellStats[];
  byCategory: (CellStats & { category: string })[];
  byChain: (CellStats & { chain: string })[];
  paired: PairedComparison[];
  failureModes: { modelId: string; condition: ConditionId; counts: Record<string, number> }[];
  errorCounts: { modelId: string; condition: ConditionId; counts: Record<string, number> }[];
  perTask: { taskId: string; category: string; rates: Partial<Record<ConditionId, { n: number; rate: number }>> }[];
  infraErrors: number;
}

export interface LoadOptions {
  includeMock?: boolean;
  /** Restrict to one task-set fingerprint; defaults to the most common one. */
  taskSetHash?: string;
}

export async function findResultFiles(root: string): Promise<string[]> {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const p = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await findResultFiles(p)));
    else if (entry.name === "runs.jsonl") out.push(p);
  }
  return out.sort();
}

export async function loadRecords(files: string[]): Promise<RunRecord[]> {
  const byId = new Map<string, RunRecord>();
  for (const f of files) {
    for (const line of (await readFile(f, "utf8")).split("\n")) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line) as RunRecord;
        byId.set(r.runId, r); // later lines supersede earlier ones (e.g. retried errors)
      } catch {
        // skip malformed lines
      }
    }
  }
  return [...byId.values()];
}

function cell(rows: RunRecord[], modelId: string, condition: ConditionId, toolCount?: number): CellStats {
  const n = rows.length;
  const successes = rows.filter((r) => r.outcome === "success").length;
  return {
    modelId,
    condition,
    ...(toolCount !== undefined ? { toolCount } : {}),
    n,
    successes,
    successRate: n ? successes / n : 0,
    ci95: wilson(successes, n),
    meanScore: mean(rows.map((r) => r.score)),
    meanPromptTokens: mean(rows.map((r) => r.promptTokens)),
    meanCompletionTokens: mean(rows.map((r) => r.completionTokens)),
    meanPromptChars: mean(rows.map((r) => r.promptChars)),
    meanTurns: mean(rows.map((r) => r.turns)),
    meanMcpCalls: mean(rows.map((r) => r.mcpCalls)),
    medianWallSeconds: median(rows.map((r) => r.wallMs / 1000)),
    meanPiiExposed: mean(rows.map((r) => r.piiExposed)),
    contextSaturatedRate: n ? rows.filter((r) => r.contextSaturated).length / n : 0,
  };
}

const condOrder = (c: ConditionId) => CONDITION_IDS.indexOf(c);

export function aggregate(all: RunRecord[], files: string[], opts: LoadOptions = {}): ReportData {
  const excluded: Record<string, number> = {};
  const bump = (k: string) => (excluded[k] = (excluded[k] ?? 0) + 1);

  let rows = all.filter((r) => {
    if (r.provider === "mock" && !opts.includeMock) {
      bump("mock provider (harness tests only)");
      return false;
    }
    return true;
  });
  const hashes = groupBy(rows, (r) => r.taskSetHash);
  const chosenHash = opts.taskSetHash ?? [...hashes.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0]?.[0] ?? null;
  rows = rows.filter((r) => {
    if (r.taskSetHash !== chosenHash) {
      bump(`different task-set fingerprint (${r.taskSetHash})`);
      return false;
    }
    return true;
  });
  const infraErrors = rows.filter((r) => r.outcome === "error").length;
  const scored = rows.filter((r) => r.outcome !== "error");
  if (infraErrors) excluded["infrastructure/provider errors"] = infraErrors;

  const sortCells = <T extends CellStats>(cells: T[]) =>
    cells.sort((a, b) => a.modelId.localeCompare(b.modelId) || (a.toolCount ?? 0) - (b.toolCount ?? 0) || condOrder(a.condition) - condOrder(b.condition));

  const overall = sortCells(
    [...groupBy(scored, (r) => `${r.modelId}|${r.condition}`).entries()].map(([k, rs]) => {
      const [m, c] = k.split("|") as [string, ConditionId];
      return cell(rs, m, c);
    }),
  );
  const byToolCount = sortCells(
    [...groupBy(scored, (r) => `${r.modelId}|${r.condition}|${r.toolCount}`).entries()].map(([k, rs]) => {
      const [m, c, t] = k.split("|") as [string, ConditionId, string];
      return cell(rs, m, c, Number(t));
    }),
  );
  const byCategory = sortCells(
    [...groupBy(scored, (r) => `${r.modelId}|${r.condition}|${r.category}`).entries()].map(([k, rs]) => {
      const [m, c, cat] = k.split("|") as [string, ConditionId, string];
      return { ...cell(rs, m, c), category: cat };
    }),
  ).sort((a, b) => a.category.localeCompare(b.category) || a.modelId.localeCompare(b.modelId) || condOrder(a.condition) - condOrder(b.condition));
  const byChain = sortCells(
    [...groupBy(scored, (r) => `${r.modelId}|${r.condition}|${r.chain}`).entries()].map(([k, rs]) => {
      const [m, c, ch] = k.split("|") as [string, ConditionId, string];
      return { ...cell(rs, m, c), chain: ch };
    }),
  ).sort((a, b) => a.chain.localeCompare(b.chain) || a.modelId.localeCompare(b.modelId) || condOrder(a.condition) - condOrder(b.condition));

  // Paired comparisons against direct tool calling, matched on (task, seed).
  const paired: PairedComparison[] = [];
  for (const [k, rs] of groupBy(scored, (r) => `${r.modelId}|${r.toolCount}`)) {
    const [modelId, tc] = k.split("|") as [string, string];
    const base = new Map(rs.filter((r) => r.condition === "direct").map((r) => [`${r.taskId}|${r.seed}`, r]));
    if (base.size === 0) continue;
    for (const treatment of CONDITION_IDS.filter((c) => c !== "direct")) {
      const pairs = rs.filter((r) => r.condition === treatment && base.has(`${r.taskId}|${r.seed}`)).map((r) => [base.get(`${r.taskId}|${r.seed}`)!, r] as const);
      if (pairs.length === 0) continue;
      const onlyBaseline = pairs.filter(([a, b]) => a.outcome === "success" && b.outcome !== "success").length;
      const onlyTreatment = pairs.filter(([a, b]) => a.outcome !== "success" && b.outcome === "success").length;
      const baselineRate = pairs.filter(([a]) => a.outcome === "success").length / pairs.length;
      const treatmentRate = pairs.filter(([, b]) => b.outcome === "success").length / pairs.length;
      paired.push({
        modelId,
        toolCount: Number(tc),
        baseline: "direct",
        treatment,
        pairs: pairs.length,
        baselineRate,
        treatmentRate,
        delta: treatmentRate - baselineRate,
        onlyBaseline,
        onlyTreatment,
        pValue: mcnemarExact(onlyBaseline, onlyTreatment),
      });
    }
  }
  paired.sort((a, b) => a.modelId.localeCompare(b.modelId) || a.toolCount - b.toolCount || condOrder(a.treatment) - condOrder(b.treatment));

  const countMap = (rs: RunRecord[], f: (r: RunRecord) => Record<string, number>) => {
    const out: Record<string, number> = {};
    for (const r of rs) for (const [k, v] of Object.entries(f(r))) out[k] = (out[k] ?? 0) + v;
    return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
  };
  const byModelCond = [...groupBy(scored, (r) => `${r.modelId}|${r.condition}`).entries()].sort(([a], [b]) => a.localeCompare(b));
  const failureModes = byModelCond.map(([k, rs]) => {
    const [modelId, condition] = k.split("|") as [string, ConditionId];
    return { modelId, condition, counts: countMap(rs, (r) => ({ [r.failureMode ?? "success"]: 1 })) };
  });
  const errorCounts = byModelCond.map(([k, rs]) => {
    const [modelId, condition] = k.split("|") as [string, ConditionId];
    return { modelId, condition, counts: countMap(rs, (r) => r.errorCounts) };
  });

  const perTask = [...groupBy(scored, (r) => r.taskId).entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([taskId, rs]) => ({
      taskId,
      category: rs[0]!.category,
      rates: Object.fromEntries(
        [...groupBy(rs, (r) => r.condition).entries()].map(([c, cr]) => [c, { n: cr.length, rate: cr.filter((r) => r.outcome === "success").length / cr.length }]),
      ) as Partial<Record<ConditionId, { n: number; rate: number }>>,
    }));

  const modelRows = [...groupBy(scored, (r) => r.modelId).entries()].sort(([a], [b]) => a.localeCompare(b));
  const models: ModelSummary[] = modelRows.map(([modelId, rs]) => {
    const r = rs[0]!;
    return {
      modelId,
      provider: r.provider,
      model: r.model,
      digest: r.modelInfo?.digest,
      parameterSize: r.modelInfo?.parameterSize,
      quantization: r.modelInfo?.quantization,
      contextWindow: r.sampling?.contextWindow,
      temperature: r.sampling?.temperature,
      topP: r.sampling?.topP,
    };
  });

  const dates = scored.map((r) => r.startedAt).sort();
  const uniq = (xs: (string | null | undefined)[]) => [...new Set(xs.filter((x): x is string => !!x))].sort();
  return {
    generatedFrom: { files, rows: all.length, includedRows: scored.length, excluded },
    taskSetHash: chosenHash,
    harnessVersions: uniq(scored.map((r) => r.harnessVersion)),
    gitCommits: uniq(scored.map((r) => (r.git?.commit ? r.git.commit.slice(0, 10) + (r.git.dirty ? "+dirty" : "") : null))),
    dateRange: dates.length ? [dates[0]!.slice(0, 10), dates[dates.length - 1]!.slice(0, 10)] : null,
    hardware: uniq(scored.map((r) => (r.hardware ? `${r.hardware.cpu}, ${r.hardware.ramGb} GB RAM${r.hardware.gpus.length ? ", " + r.hardware.gpus.join(" + ") : ""}` : null))),
    models,
    conditions: [...new Set(scored.map((r) => r.condition))].sort((a, b) => condOrder(a) - condOrder(b)),
    toolCounts: [...new Set(scored.map((r) => r.toolCount))].sort((a, b) => a - b),
    overall,
    byToolCount,
    byCategory,
    byChain,
    paired,
    failureModes,
    errorCounts,
    perTask,
    infraErrors,
  };
}
