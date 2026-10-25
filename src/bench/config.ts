import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { z } from "zod";
import { CONDITION_IDS } from "../conditions/types.js";
import { DEFAULT_WORLD_SEED } from "../world/generate.js";

const ModelSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i, "model id must be a simple identifier"),
  provider: z.enum(["ollama", "openai-compatible", "groq", "gemini", "openrouter", "mock"]),
  model: z.string(),
  baseUrl: z.string().optional(),
  apiKeyEnv: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  maxTokens: z.number().int().positive().optional(),
  think: z.boolean().optional(),
  requestsPerMinute: z.number().positive().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const GridSchema = z.object({
  tasks: z.union([z.enum(["all", "pilot"]), z.array(z.string()).min(1)]),
  conditions: z.array(z.enum(CONDITION_IDS)).min(1),
  toolCounts: z.array(z.number().int().min(1)).min(1),
  seeds: z.array(z.number().int()).min(1),
  /** Model IDs to run; defaults to every model in the config. */
  models: z.array(z.string()).optional(),
});

export const ExperimentConfigSchema = z.object({
  name: z.string().regex(/^[a-z0-9][a-z0-9._-]*$/i),
  description: z.string().default(""),
  worldSeed: z.number().int().default(DEFAULT_WORLD_SEED),
  maxTurns: z.number().int().min(1).default(20),
  lenientParsing: z.boolean().default(true),
  maxResultChars: z.number().int().positive().default(100_000),
  /** Wall-clock safety limit per run, in seconds. */
  maxRunSeconds: z.number().int().positive().default(900),
  sandbox: z
    .object({
      timeoutMs: z.number().int().positive().default(30_000),
      memoryLimitMb: z.number().int().positive().default(64),
      maxHostCalls: z.number().int().positive().default(300),
    })
    .default({ timeoutMs: 30_000, memoryLimitMb: 64, maxHostCalls: 300 }),
  cache: z.boolean().default(true),
  output: z.string().optional(),
  models: z.array(ModelSchema).min(1),
  grids: z.array(GridSchema).min(1),
});

export type ExperimentConfig = z.infer<typeof ExperimentConfigSchema>;
export type GridConfig = z.infer<typeof GridSchema>;

export async function loadConfig(path: string): Promise<ExperimentConfig> {
  const raw = parse(await readFile(path, "utf8"));
  const parsed = ExperimentConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new Error(`Invalid config ${path}:\n${issues}`);
  }
  const cfg = parsed.data;
  const ids = new Set(cfg.models.map((m) => m.id));
  if (ids.size !== cfg.models.length) throw new Error(`Invalid config ${path}: duplicate model ids`);
  for (const g of cfg.grids) for (const m of g.models ?? []) if (!ids.has(m)) throw new Error(`Invalid config ${path}: grid references unknown model '${m}'`);
  return cfg;
}
