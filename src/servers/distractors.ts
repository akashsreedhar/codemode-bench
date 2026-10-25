import { z } from "zod";
import { createRng } from "../world/generate.js";
import { FilteredServer, type ServerFactoryResult } from "./registry.js";
import { jsonResult } from "./schemas.js";

/**
 * Distractor tools: plausible business tools from unrelated domains. They are
 * functional (they return deterministic data) but no benchmark task needs
 * them. They let us vary the number of tools an agent sees without changing
 * the tasks.
 */

const DOMAINS = {
  hr: { label: "HR", nouns: ["employee", "leave_request", "payslip", "job_posting"] },
  inventory: { label: "inventory", nouns: ["stock_item", "warehouse", "purchase_order", "supplier"] },
  marketing: { label: "marketing", nouns: ["campaign", "audience_segment", "landing_page", "newsletter"] },
  devops: { label: "DevOps", nouns: ["deployment", "incident", "alert_rule", "service"] },
  finance: { label: "finance", nouns: ["expense_report", "budget", "vendor_payment", "ledger_entry"] },
  analytics: { label: "analytics", nouns: ["dashboard", "metric", "funnel", "cohort"] },
} as const;
export type DistractorDomain = keyof typeof DOMAINS;
export const DISTRACTOR_DOMAINS = Object.keys(DOMAINS) as DistractorDomain[];

const VERBS = ["list", "get", "create", "update", "archive", "export"] as const;
type Verb = (typeof VERBS)[number];

export interface DistractorSpec {
  name: string;
  domain: DistractorDomain;
  noun: string;
  verb: Verb;
  description: string;
}

const human = (noun: string) => noun.replace(/_/g, " ");

function describe(domain: DistractorDomain, verb: Verb, noun: string): string {
  const d = DOMAINS[domain].label;
  const n = human(noun);
  switch (verb) {
    case "list":
      return `List ${n} records in the ${d} system. Supports optional free-text query, status filter and limit.`;
    case "get":
      return `Get a single ${n} from the ${d} system by its ID.`;
    case "create":
      return `Create a new ${n} in the ${d} system and return its ID.`;
    case "update":
      return `Update fields of an existing ${n} in the ${d} system.`;
    case "archive":
      return `Archive a ${n} in the ${d} system. Archived records are hidden from list results.`;
    case "export":
      return `Export ${n} records from the ${d} system as CSV or JSON.`;
  }
}

/** All distractor specs in a fixed order that interleaves domains, so any prefix is domain-balanced. */
export function allDistractorSpecs(): DistractorSpec[] {
  const out: DistractorSpec[] = [];
  for (let n = 0; n < 4; n++) {
    for (const verb of VERBS) {
      for (const domain of DISTRACTOR_DOMAINS) {
        const noun = DOMAINS[domain].nouns[n]!;
        out.push({ name: `${domain}_${verb}_${noun}`, domain, noun, verb, description: describe(domain, verb, noun) });
      }
    }
  }
  return out;
}

export const MAX_DISTRACTORS = allDistractorSpecs().length;

function inputShape(verb: Verb): z.ZodRawShape {
  switch (verb) {
    case "list":
      return {
        query: z.string().optional(),
        status: z.string().optional(),
        limit: z.number().int().min(1).max(100).optional(),
      };
    case "get":
      return { id: z.string() };
    case "create":
      return { name: z.string(), description: z.string().optional(), owner: z.string().optional() };
    case "update":
      return { id: z.string(), fields: z.record(z.string(), z.string()) };
    case "archive":
      return { id: z.string(), reason: z.string().optional() };
    case "export":
      return { format: z.enum(["csv", "json"]), since: z.string().optional() };
  }
}

function record(spec: DistractorSpec, index: number, rng: ReturnType<typeof createRng>) {
  const prefix = spec.noun.split("_").map((w) => w[0]!.toUpperCase()).join("");
  return {
    id: `${prefix}-${String(index).padStart(3, "0")}`,
    name: `${human(spec.noun)} ${index}`,
    status: rng.pick(["active", "draft", "pending", "archived"]),
    owner: rng.pick(["platform", "finance", "people-ops", "growth"]),
    updated_at: `2026-03-${String(rng.int(1, 14)).padStart(2, "0")}T10:00:00.000Z`,
  };
}

export function createDistractorServer(
  domain: DistractorDomain,
  specs: DistractorSpec[],
  seed: number,
): ServerFactoryResult {
  const s = new FilteredServer(domain);
  for (const spec of specs) {
    const rng = createRng(seed ^ hash(spec.name));
    s.tool(spec.name, { description: spec.description, inputSchema: inputShape(spec.verb) }, async (args: Record<string, unknown>) => {
      switch (spec.verb) {
        case "list": {
          const limit = typeof args.limit === "number" ? args.limit : 5;
          return jsonResult({ items: Array.from({ length: Math.min(limit, 5) }, (_, i) => record(spec, i + 1, rng)), total: 5 });
        }
        case "get":
          return jsonResult({ ...record(spec, 1, rng), id: String(args.id) });
        case "create":
          return jsonResult({ id: record(spec, 900 + rng.int(0, 99), rng).id, created: true });
        case "update":
          return jsonResult({ id: String(args.id), updated: true });
        case "archive":
          return jsonResult({ id: String(args.id), archived: true });
        case "export":
          return jsonResult({ format: String(args.format), rows: 5, url: `https://exports.internal.example/${spec.name}.${String(args.format)}` });
      }
    });
  }
  return { name: domain, server: s.server, tools: s.registered };
}

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}
