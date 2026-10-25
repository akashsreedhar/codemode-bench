#!/usr/bin/env node
import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { loadConfig } from "./bench/config.js";
import { runBenchmark } from "./bench/run.js";
import { estimateTokens, generateDeclarations } from "./codemode/codegen.js";
import { CONDITION_LABELS, createCondition } from "./conditions/index.js";
import { CONDITION_IDS, toToolDefinition } from "./conditions/types.js";
import { McpPool } from "./mcp/pool.js";
import { buildReport } from "./report/build.js";
import { CORE_TOOLS, createServers, planExposure } from "./servers/index.js";
import { TASKS } from "./tasks/suite.js";
import { generateWorld } from "./world/generate.js";

const HELP = `codemode-bench — direct MCP tool calling vs. Code Mode

Usage:
  codemode-bench bench   --config <file> [--limit N] [--shard i/n] [--models a,b] [--dry-run]
  codemode-bench report  [--results results] [--out reports] [--readme README.md | --no-readme] [--include-mock]
  codemode-bench inspect --server "<command> [args...]" [--dts out.d.ts]
  codemode-bench codegen [--tools N] [--out file.d.ts]
  codemode-bench tasks   [--markdown docs/TASKS.md]
  codemode-bench sizes   [--tools 5,20,50,150]

Commands:
  bench    Run an experiment grid. Resumable: completed runs are skipped.
  report   Aggregate results into reports/ and the README results section.
  inspect  Connect to any stdio MCP server; compare the size of its tool schemas
           (direct mode) with the generated TypeScript API (Code Mode).
  codegen  Print the TypeScript API generated for the built-in benchmark servers.
  tasks    List the benchmark tasks.
  sizes    Print the static context cost (system prompt + tool definitions) of
           each condition's first request, by number of tools exposed.
`;

function splitCommand(cmd: string): string[] {
  const parts = cmd.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return parts.map((p) => p.replace(/^["']|["']$/g, ""));
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  switch (command) {
    case "bench": {
      const { values } = parseArgs({
        args: rest,
        options: { config: { type: "string" }, limit: { type: "string" }, shard: { type: "string" }, models: { type: "string" }, "dry-run": { type: "boolean" }, output: { type: "string" } },
      });
      if (!values.config) throw new Error("bench requires --config <file>");
      const config = await loadConfig(values.config);
      const r = await runBenchmark(config, {
        limit: values.limit ? Number(values.limit) : undefined,
        shard: values.shard,
        models: values.models?.split(",").map((s) => s.trim()),
        dryRun: values["dry-run"],
        output: values.output,
      });
      console.log(`Done. ${r.executed} runs executed. Results: ${r.outputDir}/runs.jsonl`);
      break;
    }
    case "report": {
      const { values } = parseArgs({
        args: rest,
        options: { results: { type: "string" }, out: { type: "string" }, readme: { type: "string" }, "no-readme": { type: "boolean" }, "include-mock": { type: "boolean" }, "task-set": { type: "string" } },
      });
      const data = await buildReport({
        resultsDir: values.results ?? "results",
        outDir: values.out ?? "reports",
        readme: values["no-readme"] ? null : (values.readme ?? "README.md"),
        includeMock: values["include-mock"],
        taskSetHash: values["task-set"],
      });
      console.log(`Report written to ${values.out ?? "reports"}/ (${data.generatedFrom.includedRows} runs included${Object.keys(data.generatedFrom.excluded).length ? `, excluded: ${JSON.stringify(data.generatedFrom.excluded)}` : ""}).`);
      break;
    }
    case "inspect": {
      const { values } = parseArgs({ args: rest, options: { server: { type: "string" }, dts: { type: "string" } } });
      if (!values.server) throw new Error('inspect requires --server "<command> [args...]"');
      const [cmd, ...args] = splitCommand(values.server);
      const pool = new McpPool();
      try {
        await pool.addStdio("server", cmd!, args);
        const tools = pool.tools;
        const schemas = JSON.stringify(tools.map(toToolDefinition));
        const dts = generateDeclarations(tools);
        console.log(`Tools: ${tools.length}`);
        console.log(`Direct mode  — tool schemas sent on every request: ${schemas.length.toLocaleString()} chars (~${estimateTokens(schemas).toLocaleString()} tokens)`);
        console.log(`Code Mode    — generated TypeScript API:          ${dts.length.toLocaleString()} chars (~${estimateTokens(dts).toLocaleString()} tokens)`);
        console.log(`Token estimates use ~4 characters per token and are indicative only.`);
        if (values.dts) {
          await writeFile(values.dts, dts);
          console.log(`Declarations written to ${values.dts}`);
        }
      } finally {
        await pool.close();
      }
      break;
    }
    case "codegen": {
      const { values } = parseArgs({ args: rest, options: { tools: { type: "string" }, out: { type: "string" } } });
      const count = values.tools ? Number(values.tools) : CORE_TOOLS.length;
      const pool = new McpPool();
      try {
        for (const s of createServers(generateWorld(), planExposure([], count))) await pool.addInMemory(s.name, s.server);
        const dts = generateDeclarations(pool.tools);
        if (values.out) await writeFile(values.out, dts);
        else process.stdout.write(dts);
      } finally {
        await pool.close();
      }
      break;
    }
    case "tasks": {
      const { values } = parseArgs({ args: rest, options: { markdown: { type: "string" } } });
      const world = generateWorld();
      const rows = TASKS.map((t) => ({ t, prompt: t.prompt(t.params(world)) }));
      if (values.markdown) {
        const md = [
          "# Task suite",
          "",
          "Generated by `npm run tasks -- --markdown docs/TASKS.md`. Prompts are shown as rendered for the default world seed.",
          "",
          "| # | ID | Category | Chain | Payload | Pilot | Required tools | Prompt |",
          "|---|---|---|---|---|---|---|---|",
          ...rows.map(({ t, prompt }, i) => `| ${i + 1} | \`${t.id}\` | ${t.category} | ${t.chain} | ${t.payload} | ${t.pilot ? "✓" : ""} | ${t.requiredTools.map((x) => `\`${x}\``).join(", ")} | ${prompt.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`),
          "",
        ].join("\n");
        await writeFile(values.markdown, md);
        console.log(`Wrote ${values.markdown}`);
      } else {
        for (const { t, prompt } of rows) console.log(`${t.pilot ? "*" : " "} ${t.id.padEnd(46)} ${t.category.padEnd(10)} ${t.chain.padEnd(7)} ${prompt.slice(0, 90)}`);
        console.log(`\n${TASKS.length} tasks (${TASKS.filter((t) => t.pilot).length} in the pilot subset, marked *).`);
      }
      break;
    }
    case "sizes": {
      const { values } = parseArgs({ args: rest, options: { tools: { type: "string" } } });
      const counts = (values.tools ?? "5,20,50,150").split(",").map(Number);
      const header = ["Tools exposed", ...CONDITION_IDS.map((c) => CONDITION_LABELS[c])];
      console.log(`| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|`);
      for (const n of counts) {
        const pool = new McpPool();
        try {
          for (const s of createServers(generateWorld(), planExposure([], n))) await pool.addInMemory(s.name, s.server);
          const cells = CONDITION_IDS.map((id) => {
            const c = createCondition(id, pool, { sandbox: {}, maxResultChars: 100_000 });
            const chars = c.systemPrompt().length + JSON.stringify(c.tools()).length;
            return `${chars.toLocaleString("en-US")} chars (~${estimateTokens(" ".repeat(chars)).toLocaleString("en-US")} tok)`;
          });
          console.log(`| ${n} | ${cells.join(" | ")} |`);
        } finally {
          await pool.close();
        }
      }
      console.log("\nToken figures are estimates at ~4 characters per token. Excludes the task prompt and all later turns.");
      break;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      break;
    default:
      console.error(`Unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
