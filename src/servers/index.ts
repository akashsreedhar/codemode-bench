import type { World } from "../world/types.js";
import { COMMS_TOOLS, createCommsServer } from "./comms.js";
import { CRM_TOOLS, createCrmServer } from "./crm.js";
import { DISTRACTOR_DOMAINS, allDistractorSpecs, createDistractorServer, type DistractorSpec } from "./distractors.js";
import { FILE_TOOLS, createFilesServer } from "./files.js";
import type { ServerFactoryResult } from "./registry.js";
import { TICKET_TOOLS, createTicketsServer } from "./tickets.js";

/** Tools that benchmark tasks can actually need, in a stable order. */
export const CORE_TOOLS: readonly string[] = [...CRM_TOOLS, ...TICKET_TOOLS, ...FILE_TOOLS, ...COMMS_TOOLS];

export interface Exposure {
  /** Core tools exposed to the agent. */
  core: string[];
  /** Distractor tools exposed to the agent. */
  distractors: DistractorSpec[];
  /** Total number of tools the agent can see. */
  total: number;
}

/**
 * Decide which tools a run exposes for a target tool count.
 *
 * Required tools are always included. Below the core-tool count, the
 * remaining slots are filled with other core tools in a deterministic order;
 * above it, all core tools are exposed and the rest is distractors.
 */
export function planExposure(required: readonly string[], toolCount: number): Exposure {
  for (const r of required) if (!CORE_TOOLS.includes(r)) throw new Error(`Unknown required tool: ${r}`);
  const core = [...required];
  for (const t of CORE_TOOLS) {
    if (core.length >= toolCount) break;
    if (!core.includes(t)) core.push(t);
  }
  const distractorCount = Math.max(0, toolCount - core.length);
  const pool = allDistractorSpecs();
  if (distractorCount > pool.length) {
    throw new Error(`toolCount ${toolCount} exceeds the maximum of ${CORE_TOOLS.length + pool.length}`);
  }
  const distractors = pool.slice(0, distractorCount);
  return { core: core.sort((a, b) => CORE_TOOLS.indexOf(a) - CORE_TOOLS.indexOf(b)), distractors, total: core.length + distractors.length };
}

export function createServers(world: World, exposure: Exposure): ServerFactoryResult[] {
  const allowed = new Set(exposure.core);
  const servers = [
    createCrmServer(world, allowed),
    createTicketsServer(world, allowed),
    createFilesServer(world, allowed),
    createCommsServer(world, allowed),
  ].filter((s) => s.tools.length > 0);
  for (const domain of DISTRACTOR_DOMAINS) {
    const specs = exposure.distractors.filter((d) => d.domain === domain);
    if (specs.length > 0) servers.push(createDistractorServer(domain, specs, world.seed));
  }
  return servers;
}

export const isDistractorTool = (name: string) => !CORE_TOOLS.includes(name);
