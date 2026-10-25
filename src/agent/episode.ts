import { createCondition, type CallErrorKind, type ConditionId } from "../conditions/index.js";
import type { SandboxOptions } from "../codemode/sandbox.js";
import { ContextOverflowError, type ChatMessage, type LLMBackend, type ToolCall } from "../llm/types.js";
import { McpPool } from "../mcp/pool.js";
import { createServers, isDistractorTool, planExposure } from "../servers/index.js";
import type { TaskDefinition } from "../tasks/types.js";
import type { Verification } from "../tasks/verify.js";
import { cloneWorld, generateWorld } from "../world/generate.js";
import type { World } from "../world/types.js";

export interface EpisodeSpec {
  task: TaskDefinition<any>;
  condition: ConditionId;
  toolCount: number;
  seed: number;
  maxTurns: number;
  lenientParsing: boolean;
  worldSeed: number;
  contextWindow?: number;
  sandbox: Partial<SandboxOptions>;
  maxResultChars: number;
}

/** Everything a backend factory may need, e.g. to script the reference solution. */
export interface EpisodeContext {
  spec: EpisodeSpec;
  params: unknown;
  pool: McpPool;
}

export type BackendFactory = (ctx: EpisodeContext) => LLMBackend;

export type Outcome = "success" | "failure" | "error";
export type FailureMode = "wrong_result" | "no_answer" | "turn_limit" | "context_overflow";

export interface TurnRecord {
  turn: number;
  promptChars: number;
  promptTokens: number;
  completionTokens: number;
  latencyMs: number;
  cached: boolean;
  finishReason: string;
  toolCalls: number;
  recoveredFromText: boolean;
}

export interface EpisodeResult {
  outcome: Outcome;
  failureMode?: FailureMode;
  verification?: Verification;
  answer: string;
  exposedTools: number;
  turns: number;
  toolCallsEmitted: number;
  mcpCalls: number;
  distractorCalls: number;
  errorCounts: Partial<Record<CallErrorKind, number>>;
  recoveredFromText: number;
  usage: { promptTokens: number; completionTokens: number };
  promptChars: { total: number; max: number; firstTurn: number };
  contextSaturated: boolean;
  llmLatencyMs: number;
  wallMs: number;
  cachedResponses: number;
  piiExposed: number;
  truncatedResults: number;
  providerError?: string;
  messages: ChatMessage[];
  turnLog: TurnRecord[];
}

const worldCache = new Map<number, World>();
function baseWorld(seed: number): World {
  if (!worldCache.has(seed)) worldCache.set(seed, generateWorld(seed));
  return worldCache.get(seed)!;
}

function requestChars(messages: ChatMessage[], toolsJson: string): number {
  let n = toolsJson.length;
  for (const m of messages) {
    n += m.content.length;
    if (m.role === "assistant" && m.toolCalls) n += JSON.stringify(m.toolCalls.map((c) => ({ name: c.name, arguments: c.arguments }))).length;
  }
  return n;
}

/** Count distinct customer emails and phone numbers that reached the model's context. */
function countPii(messages: ChatMessage[], world: World): number {
  const text = messages
    .filter((m) => m.role !== "system")
    .map((m) => m.content + (m.role === "assistant" && m.toolCalls ? JSON.stringify(m.toolCalls) : ""))
    .join("\n");
  let n = 0;
  for (const c of world.customers) {
    if (text.includes(c.email)) n++;
    if (text.includes(c.phone)) n++;
  }
  return n;
}

/** Run one task under one condition with one model, from a fresh world. */
export async function runEpisode(spec: EpisodeSpec, backendFactory: BackendFactory): Promise<EpisodeResult> {
  const started = Date.now();
  const initial = baseWorld(spec.worldSeed);
  const world = cloneWorld(initial);
  const params = spec.task.params(initial);

  const exposure = planExposure(spec.task.requiredTools, spec.toolCount);
  const pool = new McpPool();
  for (const s of createServers(world, exposure)) await pool.addInMemory(s.name, s.server);

  const condition = createCondition(spec.condition, pool, { sandbox: spec.sandbox, maxResultChars: spec.maxResultChars });
  const backend = backendFactory({ spec, params, pool });
  const messages: ChatMessage[] = [
    { role: "system", content: condition.systemPrompt() },
    { role: "user", content: spec.task.prompt(params) },
  ];

  const result: EpisodeResult = {
    outcome: "failure",
    answer: "",
    exposedTools: exposure.total,
    turns: 0,
    toolCallsEmitted: 0,
    mcpCalls: 0,
    distractorCalls: 0,
    errorCounts: {},
    recoveredFromText: 0,
    usage: { promptTokens: 0, completionTokens: 0 },
    promptChars: { total: 0, max: 0, firstTurn: 0 },
    contextSaturated: false,
    llmLatencyMs: 0,
    wallMs: 0,
    cachedResponses: 0,
    piiExposed: 0,
    truncatedResults: 0,
    messages,
    turnLog: [],
  };

  let finished = false;
  try {
    for (let turn = 1; turn <= spec.maxTurns; turn++) {
      const tools = condition.tools();
      const chars = requestChars(messages, JSON.stringify(tools));
      result.promptChars.total += chars;
      result.promptChars.max = Math.max(result.promptChars.max, chars);
      if (turn === 1) result.promptChars.firstTurn = chars;

      let response;
      try {
        response = await backend.chat({ messages, tools, seed: spec.seed });
      } catch (err) {
        if (err instanceof ContextOverflowError) {
          result.failureMode = "context_overflow";
          result.contextSaturated = true;
          finished = true;
          break;
        }
        throw err;
      }
      result.turns = turn;
      result.usage.promptTokens += response.usage.promptTokens;
      result.usage.completionTokens += response.usage.completionTokens;
      result.llmLatencyMs += response.latencyMs;
      if (response.cached) result.cachedResponses++;
      if (spec.contextWindow && (chars / 4 > spec.contextWindow * 0.95 || response.usage.promptTokens >= spec.contextWindow * 0.98)) {
        result.contextSaturated = true;
      }

      let calls: ToolCall[] = response.toolCalls;
      let recovered = false;
      if (calls.length === 0 && spec.lenientParsing) {
        const r = condition.recoverFromText(response.content);
        if (r) {
          calls = [{ ...r, id: `recovered_${turn}` }];
          recovered = true;
          result.recoveredFromText++;
        }
      }
      result.turnLog.push({
        turn,
        promptChars: chars,
        promptTokens: response.usage.promptTokens,
        completionTokens: response.usage.completionTokens,
        latencyMs: response.latencyMs,
        cached: response.cached,
        finishReason: response.finishReason,
        toolCalls: calls.length,
        recoveredFromText: recovered,
      });
      messages.push({ role: "assistant", content: response.content, ...(calls.length ? { toolCalls: calls } : {}) });

      if (calls.length === 0) {
        result.answer = response.content;
        finished = true;
        break;
      }
      for (const call of calls) {
        result.toolCallsEmitted++;
        const handled = await condition.handle(call);
        result.mcpCalls += handled.mcpCalls.length;
        result.distractorCalls += handled.mcpCalls.filter((c) => isDistractorTool(c.name)).length;
        if (handled.errorKind) result.errorCounts[handled.errorKind] = (result.errorCounts[handled.errorKind] ?? 0) + 1;
        if (handled.truncated) result.truncatedResults++;
        messages.push({ role: "tool", content: handled.text, toolCallId: call.id, name: call.name });
      }
    }
    if (!finished) result.failureMode = "turn_limit";

    const verification = spec.task.verify({ params, initial, final: world, answer: result.answer });
    result.verification = verification;
    if (verification.pass) {
      result.outcome = "success";
      result.failureMode = undefined;
    } else {
      result.outcome = "failure";
      result.failureMode ??= result.answer.trim() ? "wrong_result" : "no_answer";
    }
  } catch (err) {
    result.outcome = "error";
    result.providerError = err instanceof Error ? err.message : String(err);
  } finally {
    result.piiExposed = countPii(messages, initial);
    result.wallMs = Date.now() - started;
    await pool.close();
  }
  return result;
}
