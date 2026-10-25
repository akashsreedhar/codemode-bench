import { describe, expect, it } from "vitest";
import { runInSandbox, type HostCall } from "../src/codemode/sandbox.js";

const echoHost: HostCall = async (name, args) => ({ ok: true, data: { name, args }, text: JSON.stringify({ name, args }) });

describe("sandbox isolation", () => {
  it.each([
    ["fetch", `await fetch("https://example.com")`],
    ["require", `require("fs")`],
    ["process", `console.log(process.env)`],
    ["dynamic import", `await import("fs")`],
    ["setTimeout", `setTimeout(() => {}, 1)`],
  ])("has no %s", async (_label, code) => {
    const r = await runInSandbox(code, [], echoHost);
    expect(r.ok).toBe(false);
  });

  it("stops infinite loops at the deadline", async () => {
    const r = await runInSandbox(`while (true) {}`, [], echoHost, { timeoutMs: 500 });
    expect(r.error?.kind).toBe("timeout");
  });

  it("enforces the memory limit", async () => {
    const r = await runInSandbox(`const a = []; for (;;) a.push(new Array(100000).fill(1));`, [], echoHost, {
      timeoutMs: 20_000,
      memoryLimitBytes: 16 * 1024 * 1024,
    });
    expect(r.ok).toBe(false);
    expect(["memory", "timeout"]).toContain(r.error?.kind);
  });

  it("detects a promise that can never settle", async () => {
    const r = await runInSandbox(`await new Promise(() => {})`, [], echoHost);
    expect(r.error?.kind).toBe("runtime");
  });
});

describe("codemode bindings", () => {
  it("bridges calls to the host and returns parsed results", async () => {
    const r = await runInSandbox(
      `const out = await codemode.crm_get_customer({ customer_id: "C001" });\nconsole.log(out.args.customer_id);\nreturn out.name;`,
      ["crm_get_customer"],
      echoHost,
    );
    expect(r.ok).toBe(true);
    expect(r.logs).toEqual(["C001"]);
    expect(r.returnValue).toBe("crm_get_customer");
    expect(r.hostCalls).toHaveLength(1);
  });

  it("supports concurrent host calls", async () => {
    const r = await runInSandbox(
      `const rs = await Promise.all([1, 2, 3, 4].map((i) => codemode.t({ i })));\nconsole.log(rs.map((x) => x.args.i).join(","));`,
      ["t"],
      echoHost,
    );
    expect(r.output).toBe("1,2,3,4");
  });

  it("reports calls to non-existent APIs", async () => {
    const r = await runInSandbox(`await codemode.delete_everything({})`, ["crm_get_customer"], echoHost);
    expect(r.error?.kind).toBe("unknown_api");
  });

  it("surfaces tool errors as catchable exceptions", async () => {
    const failing: HostCall = async () => ({ ok: false, data: null, text: "Error: Customer not found: C999" });
    const r = await runInSandbox(`try { await codemode.x({}) } catch (e) { console.log("caught: " + e.message) }`, ["x"], failing);
    expect(r.ok).toBe(true);
    expect(r.output).toBe("caught: Customer not found: C999");
  });

  it("caps the number of host calls per execution", async () => {
    const r = await runInSandbox(`for (let i = 0; i < 20; i++) await codemode.x({ i });`, ["x"], echoHost, { maxHostCalls: 5 });
    expect(r.error?.kind).toBe("host_limit");
  });

  it("reports TypeScript syntax errors with line numbers", async () => {
    const r = await runInSandbox(`const a: number = 1;\nconst b = ;`, [], echoHost);
    expect(r.error?.kind).toBe("syntax");
    expect(r.error?.message).toContain("line 2");
  });

  it("accepts type annotations and markdown fences", async () => {
    const r = await runInSandbox("```ts\ninterface P { x: number }\nconst p: P = { x: 2 };\nconsole.log(p.x * 21);\n```", [], echoHost);
    expect(r.output).toBe("42");
  });

  it("truncates oversized output", async () => {
    const r = await runInSandbox(`console.log("x".repeat(5000))`, [], echoHost, { maxOutputChars: 100 });
    expect(r.truncated).toBe(true);
    expect(r.output.length).toBeLessThan(200);
  });
});
