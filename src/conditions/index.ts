import type { McpPool } from "../mcp/pool.js";
import { createCodeModeCondition, createCodeModeDiscoveryCondition } from "./codemode.js";
import { createDirectCondition } from "./direct.js";
import { createToolSearchCondition } from "./toolsearch.js";
import type { Condition, ConditionId, ConditionOptions } from "./types.js";

export * from "./types.js";

export const CONDITION_LABELS: Record<ConditionId, string> = {
  direct: "A · Direct tool calling",
  toolsearch: "B · Tool search",
  codemode: "C · Code Mode",
  codemode_discovery: "D · Code Mode + discovery",
};

export function createCondition(id: ConditionId, pool: McpPool, options: ConditionOptions): Condition {
  switch (id) {
    case "direct":
      return createDirectCondition(pool, options);
    case "toolsearch":
      return createToolSearchCondition(pool, options);
    case "codemode":
      return createCodeModeCondition(pool, options);
    case "codemode_discovery":
      return createCodeModeDiscoveryCondition(pool, options);
  }
}
