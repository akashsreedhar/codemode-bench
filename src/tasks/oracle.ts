import { TEXT_RESULT_PREFIX, type EpisodeContext } from "../agent/episode.js";
import { ScriptedBackend, type ScriptedTurn } from "../llm/mock.js";
import type { ChatMessage, LLMBackend } from "../llm/types.js";

/**
 * A scripted "model" that solves each task with its reference solution, in
 * the interaction style of the condition under test. It proves that every
 * task is solvable through every condition and exercises the whole harness
 * without calling a real model.
 */

const META_TOOLS = new Set(["search_tools", "load_tools", "list_apis", "read_api"]);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<unknown>;

/**
 * Helper available to reference solutions: fetch every page of a list
 * endpoint (first page, then the remaining pages in parallel). Page sizes keep
 * each result well under the tool-result size cap.
 */
export const ORACLE_HELPERS = `const __PAGES = { crm_search_customers: ["customers", 100], crm_list_invoices: ["invoices", 200], tickets_search: ["tickets", 40] };
async function fetchAll(method, args) {
  const [key, size] = __PAGES[method];
  const first = await codemode[method]({ ...args, limit: size, offset: 0 });
  const offsets = [];
  for (let o = size; o < first.total; o += size) offsets.push(o);
  const rest = await Promise.all(offsets.map((offset) => codemode[method]({ ...args, limit: size, offset })));
  return { [key]: [first, ...rest].flatMap((r) => r[key]), total: first.total };
}
`;

interface Exchange {
  name: string;
  result: string;
}

/** Pair assistant tool calls with their results, in order. */
function exchanges(messages: ChatMessage[]): Exchange[] {
  const results = new Map(messages.filter((m) => m.role === "tool").map((m) => [m.toolCallId, m.content]));
  const out: Exchange[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !m.toolCalls) continue;
    for (const c of m.toolCalls) {
      const r = results.get(c.id);
      if (r !== undefined) out.push({ name: c.name, result: r });
    }
  }
  return out;
}

type ReplayStep = { done: true; answer: string } | { done: false; calls: { name: string; args: unknown }[] };

/**
 * Re-run the reference solution, replaying recorded results in order. Calls
 * that have not happened yet stay pending; every call issued before the
 * solution blocks (e.g. inside Promise.all) is returned as one parallel batch.
 */
async function replay(source: string, recorded: Exchange[]): Promise<ReplayStep> {
  let k = 0;
  const needed: { name: string; args: unknown }[] = [];
  const codemode = new Proxy(
    {},
    {
      get: (_t, name) => async (args: unknown) => {
        const prior = recorded[k];
        if (!prior) {
          needed.push({ name: String(name), args: args ?? {} });
          return new Promise(() => {});
        }
        if (prior.name !== name) throw new Error(`Oracle replay diverged: expected ${String(name)}, history has ${prior.name}`);
        k++;
        if (prior.result.startsWith("Error")) throw new Error(prior.result);
        return JSON.parse(prior.result);
      },
    },
  );
  let settled: { answer: string } | { error: unknown } | undefined;
  new AsyncFunction("codemode", source)(codemode).then(
    (answer) => (settled = { answer: String(answer) }),
    (error) => (settled = { error }),
  );
  // Let all synchronously reachable calls be issued.
  for (let i = 0; i < 5 && !settled; i++) await new Promise((r) => setImmediate(r));
  if (settled && "answer" in settled) return { done: true, answer: settled.answer };
  if (settled) throw (settled as { error: unknown }).error;
  if (needed.length === 0) throw new Error("Oracle replay stalled without issuing a call");
  return { done: false, calls: needed };
}

export function wrapOracleForSandbox(source: string): string {
  return `const __answer = await (async () => {\n${source}\n})();\nconsole.log(String(__answer));`;
}

export function createOracleBackend(ctx: EpisodeContext): LLMBackend {
  const { spec, params, pool } = ctx;
  const source = ORACLE_HELPERS + spec.task.oracle(params);
  const required = spec.task.requiredTools;

  const policy = async ({ messages }: { messages: ChatMessage[] }): Promise<ScriptedTurn> => {
    const history = exchanges(messages);
    const called = (name: string) => history.some((h) => h.name === name);

    switch (spec.condition) {
      case "direct":
      case "toolsearch": {
        if (spec.condition === "toolsearch") {
          if (!called("search_tools")) return { toolCalls: [{ name: "search_tools", arguments: { query: required[0]!.replace(/_/g, " ") } }] };
          if (!called("load_tools")) return { toolCalls: [{ name: "load_tools", arguments: { names: required } }] };
        }
        const step = await replay(source, history.filter((h) => !META_TOOLS.has(h.name)));
        return step.done ? { content: step.answer } : { toolCalls: step.calls.map((c) => ({ name: c.name, arguments: c.args })) };
      }
      case "codemode":
      case "codemode_discovery": {
        if (spec.condition === "codemode_discovery") {
          if (!called("list_apis")) return { toolCalls: [{ name: "list_apis", arguments: {} }] };
          if (!called("read_api")) {
            const namespaces = [...new Set(required.map((r) => pool.tools.find((t) => t.name === r)!.server))];
            return { toolCalls: namespaces.map((namespace) => ({ name: "read_api", arguments: { namespace } })) };
          }
        }
        if (spec.codeProtocol === "text") {
          const output = messages.filter((m) => m.role === "user" && m.content.startsWith(TEXT_RESULT_PREFIX)).at(-1);
          if (!output) return { content: "```ts\n" + wrapOracleForSandbox(source) + "\n```" };
          return { content: output.content.slice(TEXT_RESULT_PREFIX.length).trim() };
        }
        const last = history.filter((h) => h.name === "execute_code").at(-1);
        if (!last) return { toolCalls: [{ name: "execute_code", arguments: { code: wrapOracleForSandbox(source) } }] };
        return { content: last.result.trim() };
      }
    }
  };
  return new ScriptedBackend("oracle", "reference-solution", policy);
}
