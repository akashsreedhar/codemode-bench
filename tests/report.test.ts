import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ExperimentConfig } from "../src/bench/config.js";
import { ExperimentConfigSchema } from "../src/bench/config.js";
import { runBenchmark } from "../src/bench/run.js";
import { RESULTS_END, RESULTS_START, buildReport } from "../src/report/build.js";

const config = (out: string): ExperimentConfig =>
  ExperimentConfigSchema.parse({
    name: "unit",
    output: out,
    cache: false,
    models: [{ id: "oracle", provider: "mock", model: "reference-solution" }],
    grids: [{ tasks: ["lookup-customer-email", "write-create-ticket"], conditions: ["direct", "codemode"], toolCounts: [5], seeds: [1, 2] }],
  });

describe("benchmark runner and report", () => {
  it("runs a grid, resumes without re-running, and reports deterministically", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-"));
    const out = join(dir, "results", "unit");
    const quiet = () => {};
    const first = await runBenchmark(config(out), { log: quiet });
    expect(first.executed).toBe(8);
    const second = await runBenchmark(config(out), { log: quiet });
    expect(second.executed).toBe(0);

    const rows = readFileSync(join(out, "runs.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows).toHaveLength(8);
    expect(rows[0]).toMatchObject({ schemaVersion: 1, provider: "mock", outcome: "success" });
    expect(rows[0].hardware.cpu).toBeTruthy();
    expect(rows[0].taskSetHash).toMatch(/^[0-9a-f]{16}$/);

    // Mock runs are never part of published statistics.
    const readme = join(dir, "README.md");
    writeFileSync(readme, `# x\n${RESULTS_START}\nold\n${RESULTS_END}\n`);
    const published = await buildReport({ resultsDir: join(dir, "results"), outDir: join(dir, "reports"), readme });
    expect(published.generatedFrom.includedRows).toBe(0);
    expect(readFileSync(readme, "utf8")).toContain("No benchmark results have been published yet");

    // Including them (for testing the pipeline) produces stable output.
    await mkdir(join(dir, "r1"));
    const a = await buildReport({ resultsDir: join(dir, "results"), outDir: join(dir, "r1"), includeMock: true });
    const b = await buildReport({ resultsDir: join(dir, "results"), outDir: join(dir, "r2"), includeMock: true });
    expect(a.overall.every((c) => c.successRate === 1)).toBe(true);
    expect(readFileSync(join(dir, "r1", "summary.json"), "utf8")).toBe(readFileSync(join(dir, "r2", "summary.json"), "utf8"));
    expect(readFileSync(join(dir, "r1", "index.html"), "utf8")).toBe(readFileSync(join(dir, "r2", "index.html"), "utf8"));
    expect(b.paired).toHaveLength(1);
    expect(b.paired[0]).toMatchObject({ baseline: "direct", treatment: "codemode", pairs: 4, pValue: 1 });
  });

  it("validates configs", () => {
    expect(() => ExperimentConfigSchema.parse({ name: "bad name!", models: [], grids: [] })).toThrow();
  });
});
