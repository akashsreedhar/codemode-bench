import { getQuickJS, shouldInterruptAfterDeadline, type QuickJSContext, type QuickJSHandle } from "quickjs-emscripten";
import { TranspileError, transpileUserCode } from "./transpile.js";

/**
 * Executes model-written code in a QuickJS interpreter compiled to
 * WebAssembly. The guest has no access to the network, filesystem, timers,
 * process or module loader: its only capability is the `codemode` object,
 * whose methods are bridged to MCP tool calls by the host.
 */

export interface HostCallResult {
  ok: boolean;
  data: unknown;
  text: string;
}
export type HostCall = (name: string, args: unknown) => Promise<HostCallResult>;

export interface SandboxOptions {
  timeoutMs: number;
  memoryLimitBytes: number;
  maxHostCalls: number;
  maxOutputChars: number;
}

export const DEFAULT_SANDBOX_OPTIONS: SandboxOptions = {
  timeoutMs: 30_000,
  memoryLimitBytes: 64 * 1024 * 1024,
  maxHostCalls: 300,
  maxOutputChars: 100_000,
};

export type SandboxErrorKind = "syntax" | "runtime" | "unknown_api" | "tool_error" | "timeout" | "memory" | "host_limit";

export interface SandboxResult {
  ok: boolean;
  /** Text returned to the model: console output, then the return value or the error. */
  output: string;
  logs: string[];
  returnValue?: unknown;
  error?: { kind: SandboxErrorKind; message: string };
  hostCalls: { name: string; ok: boolean; ms: number }[];
  durationMs: number;
  truncated: boolean;
}

const UNKNOWN_API_MARKER = "CodemodeUnknownApi";
const TOOL_ERROR_MARKER = "CodemodeToolError";

function prelude(toolNames: readonly string[]): string {
  return `
"use strict";
const __fmt = (v) => {
  if (typeof v === "string") return v;
  if (v instanceof Error) return v.name + ": " + v.message;
  try { const s = JSON.stringify(v); return s === undefined ? String(v) : s; } catch (_) { return String(v); }
};
const __mk = (level) => (...args) => __log(level, args.map(__fmt).join(" "));
globalThis.console = Object.freeze({ log: __mk("log"), info: __mk("info"), warn: __mk("warn"), error: __mk("error"), debug: __mk("debug") });
class ${TOOL_ERROR_MARKER} extends Error { constructor(m) { super(m); this.name = "ToolError"; } }
class ${UNKNOWN_API_MARKER} extends TypeError { constructor(m) { super(m); this.name = "TypeError"; } }
const __call = async (name, input) => {
  const r = JSON.parse(await __host_call(name, JSON.stringify(input === undefined ? {} : input)));
  if (!r.ok) throw new ${TOOL_ERROR_MARKER}(r.error);
  return r.value;
};
const __tools = new Set(${JSON.stringify(toolNames)});
globalThis.codemode = new Proxy(Object.freeze({}), {
  get(_t, prop) {
    if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
    if (__tools.has(prop)) return (input) => __call(prop, input);
    return () => { throw new ${UNKNOWN_API_MARKER}("codemode." + prop + " is not a function (no such API)"); };
  },
  has(_t, prop) { return __tools.has(prop); },
  ownKeys() { return [...__tools]; },
  getOwnPropertyDescriptor(_t, prop) { return __tools.has(prop) ? { enumerable: true, configurable: true } : undefined; },
});
`;
}

function formatGuestError(dumped: unknown): { message: string; kind: SandboxErrorKind } {
  if (dumped && typeof dumped === "object") {
    const e = dumped as { name?: string; message?: string };
    const message = `${e.name ?? "Error"}: ${e.message ?? ""}`;
    if (e.message?.includes("(no such API)")) return { message, kind: "unknown_api" };
    if (e.name === "ToolError") return { message, kind: e.message?.startsWith("Host call limit") ? "host_limit" : "tool_error" };
    if (e.message === "interrupted") return { message: "Execution timed out", kind: "timeout" };
    if (/out of memory/i.test(e.message ?? "")) return { message: "Memory limit exceeded", kind: "memory" };
    if (e.name === "SyntaxError") return { message, kind: "syntax" };
    return { message, kind: "runtime" };
  }
  return { message: `Uncaught ${String(dumped)}`, kind: "runtime" };
}

export async function runInSandbox(
  code: string,
  toolNames: readonly string[],
  host: HostCall,
  options: Partial<SandboxOptions> = {},
): Promise<SandboxResult> {
  const opts = { ...DEFAULT_SANDBOX_OPTIONS, ...options };
  const started = Date.now();
  const logs: string[] = [];
  const hostCalls: SandboxResult["hostCalls"] = [];
  const finish = (partial: Omit<SandboxResult, "logs" | "hostCalls" | "durationMs" | "output" | "truncated">): SandboxResult => {
    const parts = [...logs];
    if (partial.ok && partial.returnValue !== undefined) {
      parts.push(`[return] ${typeof partial.returnValue === "string" ? partial.returnValue : JSON.stringify(partial.returnValue)}`);
    }
    if (partial.error) parts.push(`[error] ${partial.error.message}`);
    if (parts.length === 0) parts.push("[no output: use console.log() to return results]");
    let output = parts.join("\n");
    let truncated = false;
    if (output.length > opts.maxOutputChars) {
      output = output.slice(0, opts.maxOutputChars) + `\n[output truncated at ${opts.maxOutputChars} characters]`;
      truncated = true;
    }
    return { ...partial, output, logs, hostCalls, durationMs: Date.now() - started, truncated };
  };

  let js: string;
  try {
    js = await transpileUserCode(code);
  } catch (err) {
    if (err instanceof TranspileError) return finish({ ok: false, error: { kind: "syntax", message: err.message } });
    throw err;
  }

  const QuickJS = await getQuickJS();
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(opts.memoryLimitBytes);
  runtime.setMaxStackSize(1024 * 1024);
  const deadline = started + opts.timeoutMs;
  runtime.setInterruptHandler(shouldInterruptAfterDeadline(deadline));
  const ctx: QuickJSContext = runtime.newContext();

  let alive = true;
  const pending = new Set<Promise<void>>();

  const disposeAll = () => {
    alive = false;
    try {
      ctx.dispose();
      runtime.dispose();
    } catch {
      // A leaked handle only matters for long-lived runtimes; this one is discarded.
    }
  };

  try {
    const logFn = ctx.newFunction("__log", (levelH, msgH) => {
      const level = ctx.getString(levelH);
      const msg = ctx.getString(msgH);
      logs.push(level === "log" || level === "info" ? msg : `[${level}] ${msg}`);
    });
    ctx.setProp(ctx.global, "__log", logFn);
    logFn.dispose();

    const hostFn = ctx.newFunction("__host_call", (nameH, argsH) => {
      const name = ctx.getString(nameH);
      const argsJson = ctx.getString(argsH);
      const deferred = ctx.newPromise();
      const t0 = Date.now();
      const respond = (payload: unknown) => {
        if (!alive) return;
        const str = ctx.newString(JSON.stringify(payload));
        deferred.resolve(str);
        str.dispose();
      };
      if (hostCalls.length >= opts.maxHostCalls) {
        hostCalls.push({ name, ok: false, ms: 0 });
        respond({ ok: false, error: `Host call limit reached (${opts.maxHostCalls} calls per execution)` });
        return deferred.handle;
      }
      const p = (async () => {
        let args: unknown;
        try {
          args = JSON.parse(argsJson);
        } catch {
          args = {};
        }
        const r = await host(name, args);
        hostCalls.push({ name, ok: r.ok, ms: Date.now() - t0 });
        respond(r.ok ? { ok: true, value: r.data } : { ok: false, error: r.text.replace(/^Error:\s*/, "") });
      })()
        .catch((err) => respond({ ok: false, error: err instanceof Error ? err.message : String(err) }))
        .finally(() => pending.delete(p));
      pending.add(p);
      return deferred.handle;
    });
    ctx.setProp(ctx.global, "__host_call", hostFn);
    hostFn.dispose();

    const pre = ctx.evalCode(prelude(toolNames), "prelude.js");
    if (pre.error) {
      const dumped = ctx.dump(pre.error);
      pre.error.dispose();
      throw new Error(`Sandbox prelude failed: ${JSON.stringify(dumped)}`);
    }
    pre.value.dispose();

    const evaluated = ctx.evalCode(js, "main.js");
    if (evaluated.error) {
      const e = formatGuestError(ctx.dump(evaluated.error));
      evaluated.error.dispose();
      return finish({ ok: false, error: e });
    }
    evaluated.value.dispose();

    const promiseH: QuickJSHandle = ctx.getProp(ctx.global, "__result");
    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error) {
          const e = formatGuestError(ctx.dump(jobs.error));
          jobs.error.dispose();
          return finish({ ok: false, error: e });
        }
        const state = ctx.getPromiseState(promiseH);
        if (state.type === "fulfilled") {
          const value = ctx.dump(state.value);
          state.value.dispose();
          return finish({ ok: true, returnValue: value });
        }
        if (state.type === "rejected") {
          const e = formatGuestError(ctx.dump(state.error));
          state.error.dispose();
          return finish({ ok: false, error: e });
        }
        const remaining = deadline - Date.now();
        if (remaining <= 0) return finish({ ok: false, error: { kind: "timeout", message: "Execution timed out" } });
        if (pending.size === 0) {
          return finish({ ok: false, error: { kind: "runtime", message: "Error: program is waiting on a promise that can never settle" } });
        }
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          Promise.race(pending),
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, remaining);
          }),
        ]);
        clearTimeout(timer);
      }
    } finally {
      if (alive) promiseH.dispose();
    }
  } finally {
    // Outstanding host calls are allowed to finish but their results are dropped.
    disposeAll();
  }
}
