import { generateDeclarations, summariseServers } from "../codemode/codegen.js";
import { runInSandbox, type SandboxErrorKind } from "../codemode/sandbox.js";
import { stripFences } from "../codemode/transpile.js";
import type { ToolCall, ToolDefinition } from "../llm/types.js";
import type { McpPool } from "../mcp/pool.js";
import { BASE_SYSTEM_PROMPT, type CallErrorKind, type Condition, type ConditionOptions, type HandledCall, type McpCallRecord } from "./types.js";

export const EXECUTE_CODE_TOOL: ToolDefinition = {
  name: "execute_code",
  description: "Execute TypeScript in a sandbox that exposes the `codemode` API. Returns everything written with console.log(), followed by the return value or error.",
  parameters: {
    type: "object",
    properties: { code: { type: "string", description: "TypeScript source. Top-level await and return are allowed." } },
    required: ["code"],
  },
};

const SANDBOX_RULES = `How to work:
- Complete tasks by writing TypeScript and running it with the execute_code tool.
- The sandbox provides a global \`codemode\` object. Each method calls the backend tool of the same name and returns a Promise of its result.
- Top-level await and return are allowed. There is no network, filesystem, timer or module access (fetch, require and import are unavailable).
- You only see what you print with console.log() and the returned value. Print just the data you need, not whole API responses.
- Variables do not persist between executions. You may execute code several times.
- When the task is complete, reply with the final answer as plain text (not code).`;

const ERROR_MAP: Record<SandboxErrorKind, CallErrorKind> = {
  syntax: "code_syntax",
  runtime: "code_runtime",
  unknown_api: "hallucinated_api",
  tool_error: "tool_error",
  timeout: "code_timeout",
  memory: "code_limit",
  host_limit: "code_limit",
};

async function executeCode(pool: McpPool, call: ToolCall, options: ConditionOptions): Promise<HandledCall> {
  const args = (call.arguments ?? {}) as Record<string, unknown>;
  if (call.argumentParseError || typeof args.code !== "string") {
    return { ok: false, errorKind: "invalid_args", text: "Error: execute_code requires a string argument 'code'", mcpCalls: [] };
  }
  const mcpCalls: McpCallRecord[] = [];
  const result = await runInSandbox(
    args.code,
    pool.tools.map((t) => t.name),
    async (name, input) => {
      const outcome = await pool.callTool(name, input);
      mcpCalls.push({ name, ok: outcome.ok, errorKind: outcome.errorKind });
      return outcome;
    },
    { ...options.sandbox, maxOutputChars: options.maxResultChars },
  );
  let errorKind = result.error ? ERROR_MAP[result.error.kind] : undefined;
  // A ToolError raised by invalid arguments is attributed to the arguments, as in direct mode.
  if (errorKind === "tool_error" && mcpCalls.at(-1)?.errorKind === "invalid_args") errorKind = "invalid_args";
  return { ok: result.ok, errorKind, text: result.output, mcpCalls, truncated: result.truncated };
}

/** Recover code from a reply that contains a fenced code block instead of a tool call. */
export function recoverCodeBlock(content: string): ToolCall | undefined {
  const m = content.match(/```(?:ts|typescript|js|javascript)\s*\n([\s\S]*?)```/);
  if (!m || !/codemode\.|console\.log/.test(m[1]!)) return undefined;
  return { id: "recovered_0", name: "execute_code", arguments: { code: stripFences(m[1]!) } };
}

/** Condition C: the full generated TypeScript API is placed in the system prompt; one execute_code tool. */
export function createCodeModeCondition(pool: McpPool, options: ConditionOptions): Condition {
  const declarations = generateDeclarations(pool.tools, { header: false });
  return {
    id: "codemode",
    systemPrompt: () => `${BASE_SYSTEM_PROMPT}\n\n${SANDBOX_RULES}\n\nAvailable API:\n\`\`\`ts\n${declarations}\`\`\``,
    tools: () => [EXECUTE_CODE_TOOL],
    handle: (call) =>
      call.name === "execute_code"
        ? executeCode(pool, call, options)
        : Promise.resolve({ ok: false, errorKind: "unknown_tool", text: `Error: unknown tool '${call.name}'. Use execute_code.`, mcpCalls: [] }),
    recoverFromText: recoverCodeBlock,
  };
}

const LIST_APIS_TOOL: ToolDefinition = {
  name: "list_apis",
  description: "List the API namespaces available on the `codemode` object, with a one-line summary of each method.",
  parameters: { type: "object", properties: {} },
};
const READ_API_TOOL: ToolDefinition = {
  name: "read_api",
  description: "Get the full TypeScript declarations (types and documentation) for one API namespace returned by list_apis.",
  parameters: { type: "object", properties: { namespace: { type: "string" } }, required: ["namespace"] },
};

/**
 * Condition D: Code Mode with progressive API discovery. The model starts
 * with no API in context and loads TypeScript declarations on demand.
 */
export function createCodeModeDiscoveryCondition(pool: McpPool, options: ConditionOptions): Condition {
  const summaries = summariseServers(pool.tools);
  return {
    id: "codemode_discovery",
    systemPrompt: () =>
      `${BASE_SYSTEM_PROMPT}\n\n${SANDBOX_RULES}\n- The API is not shown up front. Call list_apis to see the namespaces, then read_api to get the TypeScript declarations you need before writing code.`,
    tools: () => [LIST_APIS_TOOL, READ_API_TOOL, EXECUTE_CODE_TOOL],
    async handle(call) {
      if (call.name === "list_apis") {
        return { ok: true, text: JSON.stringify({ namespaces: summaries }), mcpCalls: [] };
      }
      if (call.name === "read_api") {
        const ns = String(((call.arguments ?? {}) as Record<string, unknown>).namespace ?? "");
        const tools = pool.tools.filter((t) => t.server === ns);
        if (tools.length === 0) {
          return { ok: false, errorKind: "unknown_tool", text: `Error: unknown namespace '${ns}'. Available: ${summaries.map((s) => s.server).join(", ")}`, mcpCalls: [] };
        }
        return { ok: true, text: generateDeclarations(tools, { header: false }), mcpCalls: [] };
      }
      if (call.name === "execute_code") return executeCode(pool, call, options);
      return { ok: false, errorKind: "unknown_tool", text: `Error: unknown tool '${call.name}'`, mcpCalls: [] };
    },
    recoverFromText: recoverCodeBlock,
  };
}
