import type { ToolCall, ToolDefinition } from "../llm/types.js";
import type { McpPool, ToolInfo } from "../mcp/pool.js";
import type { SandboxOptions } from "../codemode/sandbox.js";
import { WORLD_NOW } from "../world/generate.js";

export const CONDITION_IDS = ["direct", "toolsearch", "codemode", "codemode_discovery"] as const;
export type ConditionId = (typeof CONDITION_IDS)[number];

/** Why a tool call (or a code execution) did not succeed. */
export type CallErrorKind =
  | "unknown_tool"
  | "invalid_args"
  | "tool_error"
  | "code_syntax"
  | "code_runtime"
  | "hallucinated_api"
  | "code_timeout"
  | "code_limit";

export interface McpCallRecord {
  name: string;
  ok: boolean;
  errorKind?: string;
}

export interface HandledCall {
  /** Text fed back to the model as the tool result. */
  text: string;
  ok: boolean;
  errorKind?: CallErrorKind;
  /** MCP tool calls performed while handling this call (one for direct calls, any number for code). */
  mcpCalls: McpCallRecord[];
  truncated?: boolean;
}

export interface ConditionOptions {
  sandbox: Partial<SandboxOptions>;
  /** Maximum characters of a tool result returned to the model (applies to all conditions). */
  maxResultChars: number;
}

export interface Condition {
  readonly id: ConditionId;
  systemPrompt(): string;
  /** Tools offered on the next turn (may change over a run, e.g. after load_tools). */
  tools(): ToolDefinition[];
  handle(call: ToolCall): Promise<HandledCall>;
  /** Lenient parsing: recover a tool call from a plain-text reply (common with small models). */
  recoverFromText(content: string): ToolCall | undefined;
}

export const BASE_SYSTEM_PROMPT = `You are an operations assistant for Acme Ops, a B2B software company. You complete tasks for the customer operations team using the capabilities available to you.

The current date and time is ${WORLD_NOW} (UTC).

Guidelines:
- Work autonomously until the task is fully complete. Do not ask clarifying questions; make reasonable assumptions.
- Use the available capabilities to look up real data. Never invent IDs, names or numbers.
- List endpoints are paginated with "limit" and "offset" parameters and report a "total"; make sure you have all the data a task needs.
- When the task is complete, reply with a short final answer as plain text that directly answers the request.`;

export function toToolDefinition(t: ToolInfo): ToolDefinition {
  const { $schema: _ignored, ...parameters } = t.inputSchema as Record<string, unknown>;
  return { name: t.name, description: t.description, parameters };
}

export function truncate(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: `${text.slice(0, max)}\n[result truncated at ${max} characters]`, truncated: true };
}

export type ConditionFactory = (pool: McpPool, options: ConditionOptions) => Condition;
