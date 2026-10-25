import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { generateDeclarations, pascalCase, schemaToType, summariseServers } from "../src/codemode/codegen.js";
import { McpPool } from "../src/mcp/pool.js";
import { createServers, planExposure } from "../src/servers/index.js";
import { generateWorld } from "../src/world/generate.js";

describe("schemaToType", () => {
  it("maps primitives, enums, arrays and nullability", () => {
    expect(schemaToType({ type: "string" })).toBe("string");
    expect(schemaToType({ type: "integer" })).toBe("number");
    expect(schemaToType({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(schemaToType({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(schemaToType({ type: ["string", "null"] })).toBe("string | null");
    expect(schemaToType({ anyOf: [{ type: "number" }, { type: "null" }] })).toBe("number | null");
    expect(schemaToType({ type: "object", additionalProperties: { type: "string" } })).toBe("Record<string, string>");
  });

  it("renders object properties with optionality and doc comments", () => {
    const ts = schemaToType({
      type: "object",
      properties: { id: { type: "string", description: "The ID" }, "odd-key": { type: "number" } },
      required: ["id"],
    });
    expect(ts).toContain("/** The ID */");
    expect(ts).toContain("id: string;");
    expect(ts).toContain('"odd-key"?: number;');
  });

  it("builds identifiers from tool names", () => {
    expect(pascalCase("crm_list_invoices")).toBe("CrmListInvoices");
    expect(pascalCase("get-thing.v2")).toBe("GetThingV2");
  });
});

describe("generateDeclarations", () => {
  async function poolWith(toolCount: number) {
    const pool = new McpPool();
    for (const s of createServers(generateWorld(), planExposure([], toolCount))) await pool.addInMemory(s.name, s.server);
    return pool;
  }

  it("emits one typed method per MCP tool", async () => {
    const pool = await poolWith(30);
    try {
      const dts = generateDeclarations(pool.tools);
      expect(dts).toContain("declare const codemode: {");
      for (const t of pool.tools) expect(dts).toContain(`  ${t.name}: (input: `);
      expect(dts).toContain("interface CrmListInvoicesOutput");
      // Distractor tools have no output schema.
      expect(dts).toMatch(/type HrListEmployeeOutput = unknown;/);
    } finally {
      await pool.close();
    }
  });

  it("produces declarations that pass the TypeScript compiler in strict mode", async () => {
    const pool = await poolWith(150);
    try {
      const dir = mkdtempSync(join(tmpdir(), "codemode-dts-"));
      const file = join(dir, "api.ts");
      writeFileSync(
        file,
        generateDeclarations(pool.tools) +
          `\nasync function usage() {\n  const r = await codemode.crm_list_invoices({ status: "overdue", limit: 10 });\n  const total: number = r.invoices.reduce((s, i) => s + i.amount, 0);\n  return total;\n}\nexport { usage };\n`,
      );
      const tsc = join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
      execFileSync(process.execPath, [tsc, "--ignoreConfig", "--noEmit", "--strict", "--target", "es2022", "--lib", "es2022", file], { stdio: "pipe" });
    } finally {
      await pool.close();
    }
  });

  it("summarises servers for progressive discovery", async () => {
    const pool = await poolWith(18);
    try {
      const s = summariseServers(pool.tools);
      expect(s.map((x) => x.server)).toEqual(["comms", "crm", "files", "tickets"]);
      expect(s.find((x) => x.server === "crm")!.tools).toHaveLength(5);
    } finally {
      await pool.close();
    }
  });
});
