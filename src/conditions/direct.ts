import type { ToolCall } from "../llm/types.js";
import type { McpPool } from "../mcp/pool.js";
import { BASE_SYSTEM_PROMPT, toToolDefinition, truncate, type Condition, type ConditionOptions, type HandledCall } from "./types.js";

/** Execute a native function call against the MCP pool. Shared by the direct and tool-search conditions. */
export async function callMcpTool(pool: McpPool, call: ToolCall, options: ConditionOptions): Promise<HandledCall> {
  if (call.argumentParseError) {
    return {
      ok: false,
      errorKind: "invalid_args",
      text: `Error: arguments for '${call.name}' are not valid JSON (${call.argumentParseError})`,
      mcpCalls: [{ name: call.name, ok: false, errorKind: "invalid_args" }],
    };
  }
  const outcome = await pool.callTool(call.name, call.arguments ?? {});
  const { text, truncated } = truncate(outcome.text, options.maxResultChars);
  return {
    ok: outcome.ok,
    errorKind: outcome.errorKind,
    text,
    truncated,
    mcpCalls: [{ name: call.name, ok: outcome.ok, errorKind: outcome.errorKind }],
  };
}

/**
 * Parse a tool call written as text, e.g. `<tool_call>{"name": ..., "arguments": {...}}</tool_call>`
 * or a bare JSON object, which some small models emit instead of a native call.
 */
export function recoverJsonToolCall(content: string, isKnown: (name: string) => boolean): ToolCall | undefined {
  const candidates = [
    ...[...content.matchAll(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g)].map((m) => m[1]!),
    ...[...content.matchAll(/```(?:json)?\s*\n?([\s\S]*?)```/g)].map((m) => m[1]!),
    content.trim(),
  ];
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as { name?: unknown; arguments?: unknown; parameters?: unknown };
      if (typeof obj?.name === "string" && isKnown(obj.name)) {
        return { id: "recovered_0", name: obj.name, arguments: obj.arguments ?? obj.parameters ?? {} };
      }
    } catch {
      // not JSON
    }
  }
  return undefined;
}

/** Condition A: every MCP tool is offered to the model as a native function. */
export function createDirectCondition(pool: McpPool, options: ConditionOptions): Condition {
  const definitions = pool.tools.map(toToolDefinition);
  return {
    id: "direct",
    systemPrompt: () => `${BASE_SYSTEM_PROMPT}\n- Call the provided tools to read and change data.`,
    tools: () => definitions,
    handle: (call) => callMcpTool(pool, call, options),
    recoverFromText: (content) => recoverJsonToolCall(content, (n) => pool.hasTool(n)),
  };
}
