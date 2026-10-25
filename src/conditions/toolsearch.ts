import type { ToolDefinition } from "../llm/types.js";
import type { McpPool, ToolInfo } from "../mcp/pool.js";
import { callMcpTool, recoverJsonToolCall } from "./direct.js";
import { BASE_SYSTEM_PROMPT, toToolDefinition, type Condition, type ConditionOptions } from "./types.js";

const tokenize = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);

/** Keyword relevance score used by search_tools: name matches weigh more than description matches. */
export function scoreTool(tool: ToolInfo, query: string): number {
  const name = new Set(tokenize(tool.name));
  const desc = tokenize(tool.description);
  let score = 0;
  for (const term of tokenize(query)) {
    const stem = term.replace(/(es|s)$/, "");
    if ([...name].some((n) => n === term || n.replace(/(es|s)$/, "") === stem)) score += 3;
    if (desc.some((d) => d === term || d.startsWith(stem))) score += 1;
  }
  return score;
}

const SEARCH_TOOL: ToolDefinition = {
  name: "search_tools",
  description: "Search the tool catalogue by keywords. Returns matching tool names and descriptions. Matching tools must be loaded with load_tools before they can be called.",
  parameters: {
    type: "object",
    properties: {
      query: { type: "string", description: "Keywords describing the capability you need, e.g. 'list overdue invoices'" },
      limit: { type: "integer", minimum: 1, maximum: 20, description: "Maximum number of results (default 8)" },
    },
    required: ["query"],
  },
};

const LOAD_TOOL: ToolDefinition = {
  name: "load_tools",
  description: "Load tools by name so they can be called directly on the next turn.",
  parameters: {
    type: "object",
    properties: { names: { type: "array", items: { type: "string" }, description: "Exact tool names from search_tools results" } },
    required: ["names"],
  },
};

/**
 * Condition B: tools are hidden behind a search/load step (progressive tool
 * disclosure). Controls for the "fewer tool definitions in context" effect
 * without introducing code execution.
 */
export function createToolSearchCondition(pool: McpPool, options: ConditionOptions): Condition {
  const loaded = new Map<string, ToolDefinition>();
  const byName = new Map(pool.tools.map((t) => [t.name, t]));
  return {
    id: "toolsearch",
    systemPrompt: () =>
      `${BASE_SYSTEM_PROMPT}\n- Tools are not loaded by default. Use search_tools to find the tools you need, then load_tools to make them callable, then call them.`,
    tools: () => [SEARCH_TOOL, LOAD_TOOL, ...loaded.values()],
    async handle(call) {
      const args = (call.arguments ?? {}) as Record<string, unknown>;
      if (call.name === "search_tools") {
        if (typeof args.query !== "string") return { ok: false, errorKind: "invalid_args", text: "Error: 'query' must be a string", mcpCalls: [] };
        const limit = typeof args.limit === "number" ? Math.min(20, Math.max(1, args.limit)) : 8;
        const results = pool.tools
          .map((t) => ({ t, s: scoreTool(t, args.query as string) }))
          .filter((x) => x.s > 0)
          .sort((a, b) => b.s - a.s || a.t.name.localeCompare(b.t.name))
          .slice(0, limit)
          .map(({ t }) => ({ name: t.name, description: t.description }));
        return { ok: true, text: JSON.stringify({ results }), mcpCalls: [] };
      }
      if (call.name === "load_tools") {
        const names = Array.isArray(args.names) ? args.names.filter((n): n is string => typeof n === "string") : [];
        const unknown = names.filter((n) => !byName.has(n));
        for (const n of names) if (byName.has(n)) loaded.set(n, toToolDefinition(byName.get(n)!));
        return {
          ok: unknown.length === 0 && names.length > 0,
          errorKind: unknown.length || names.length === 0 ? "unknown_tool" : undefined,
          text: JSON.stringify({ loaded: names.filter((n) => byName.has(n)), unknown }),
          mcpCalls: [],
        };
      }
      if (!loaded.has(call.name)) {
        const exists = byName.has(call.name);
        return {
          ok: false,
          errorKind: "unknown_tool",
          text: exists ? `Error: tool '${call.name}' is not loaded. Call load_tools first.` : `Error: unknown tool '${call.name}'`,
          mcpCalls: [],
        };
      }
      return callMcpTool(pool, call, options);
    },
    recoverFromText: (content) => recoverJsonToolCall(content, (n) => n === "search_tools" || n === "load_tools" || loaded.has(n)),
  };
}
