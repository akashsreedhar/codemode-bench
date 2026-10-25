import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { McpPool } from "../src/mcp/pool.js";
import { MAX_DISTRACTORS } from "../src/servers/distractors.js";
import { CORE_TOOLS, createServers, planExposure } from "../src/servers/index.js";
import { cloneWorld, generateWorld } from "../src/world/generate.js";

const digest = (v: unknown) => createHash("sha256").update(JSON.stringify(v)).digest("hex");

describe("world generation", () => {
  it("is deterministic for a seed and differs across seeds", () => {
    expect(digest(generateWorld(1337))).toBe(digest(generateWorld(1337)));
    expect(digest(generateWorld(1337))).not.toBe(digest(generateWorld(7)));
  });

  it("has the expected shape", () => {
    const w = generateWorld();
    expect(w.customers).toHaveLength(120);
    expect(w.tickets).toHaveLength(400);
    expect(new Set(w.customers.map((c) => c.email)).size).toBe(120);
    expect(w.invoices.every((i) => w.customers.some((c) => c.id === i.customer_id))).toBe(true);
  });

  it("clones deeply", () => {
    const a = generateWorld();
    const b = cloneWorld(a);
    b.customers[0]!.tier = "enterprise";
    b.customers[0]!.address.city = "Nowhere";
    expect(a.customers[0]!.address.city).not.toBe("Nowhere");
  });
});

describe("tool exposure", () => {
  it.each([5, 18, 20, 50, 150])("exposes exactly %i tools", (n) => {
    expect(planExposure(["crm_get_customer"], n).total).toBe(n);
  });

  it("always includes required tools, even below the requested count", () => {
    const e = planExposure(["crm_search_customers", "tickets_search", "tickets_update", "directory_list_staff", "email_send"], 3);
    expect(e.core).toEqual(expect.arrayContaining(["crm_search_customers", "tickets_search", "tickets_update", "directory_list_staff", "email_send"]));
    expect(e.distractors).toHaveLength(0);
  });

  it("rejects counts beyond the catalogue", () => {
    expect(() => planExposure([], CORE_TOOLS.length + MAX_DISTRACTORS + 1)).toThrow();
  });

  it("registers exactly the planned tools on the MCP servers", async () => {
    const pool = new McpPool();
    try {
      for (const s of createServers(generateWorld(), planExposure([], 60))) await pool.addInMemory(s.name, s.server);
      expect(pool.tools).toHaveLength(60);
      expect(new Set(pool.tools.map((t) => t.name)).size).toBe(60);
    } finally {
      await pool.close();
    }
  });
});

describe("MCP servers", () => {
  async function pool() {
    const world = generateWorld();
    const p = new McpPool();
    for (const s of createServers(world, planExposure([], 18))) await p.addInMemory(s.name, s.server);
    return { p, world };
  }

  it("paginates list endpoints with limit/offset", async () => {
    const { p, world } = await pool();
    try {
      const all = new Set<string>();
      let total = 0;
      for (let offset = 0; ; offset += 100) {
        const r = await p.callTool("crm_list_invoices", { limit: 100, offset });
        const page = (r.data as { invoices: { id: string }[]; total: number });
        total = page.total;
        page.invoices.forEach((i) => all.add(i.id));
        if (page.invoices.length < 100) break;
      }
      expect(total).toBe(world.invoices.length);
      expect(all.size).toBe(world.invoices.length);
    } finally {
      await p.close();
    }
  });

  it("classifies invalid arguments, unknown tools and domain errors", async () => {
    const { p } = await pool();
    try {
      expect((await p.callTool("crm_get_customer", { customer_id: 5 })).errorKind).toBe("invalid_args");
      expect((await p.callTool("crm_get_customer", { customer_id: "C999" })).errorKind).toBe("tool_error");
      expect((await p.callTool("does_not_exist", {})).errorKind).toBe("unknown_tool");
    } finally {
      await p.close();
    }
  });

  it("mutates only the run's own world", async () => {
    const { p, world } = await pool();
    try {
      await p.callTool("tickets_update", { ticket_id: "T0001", status: "closed", add_tags: ["x"] });
      expect(world.tickets[0]!.tags).toContain("x");
      expect(generateWorld().tickets[0]!.tags).not.toContain("x");
    } finally {
      await p.close();
    }
  });
});
