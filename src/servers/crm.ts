import { z } from "zod";
import type { World } from "../world/types.js";
import { FilteredServer, type ServerFactoryResult } from "./registry.js";
import { CustomerSchema, InvoiceSchema, InvoiceStatusSchema, TierSchema, ToolInputError, jsonResult } from "./schemas.js";

export const CRM_TOOLS = [
  "crm_search_customers",
  "crm_get_customer",
  "crm_update_customer",
  "crm_list_invoices",
  "crm_update_invoice",
] as const;

export function createCrmServer(world: World, allowed?: ReadonlySet<string>): ServerFactoryResult {
  const s = new FilteredServer("crm", allowed);

  const findCustomer = (id: string) => {
    const c = world.customers.find((x) => x.id === id);
    if (!c) throw new ToolInputError(`Customer not found: ${id}`);
    return c;
  };

  s.tool(
    "crm_search_customers",
    {
      description:
        "Search customer accounts. All filters are optional and combined with AND. " +
        "`query` matches name, company or email (case-insensitive substring). " +
        "Returns at most `limit` customers (default 50, max 200) starting at `offset`, plus the total number of matches.",
      inputSchema: {
        query: z.string().optional().describe("Substring to match against name, company or email"),
        tier: TierSchema.optional(),
        country: z.string().optional().describe("Exact country name, e.g. 'Germany'"),
        limit: z.number().int().min(1).max(200).optional(),
        offset: z.number().int().min(0).optional().describe("Number of matching records to skip (for pagination, default 0)"),
      },
      outputSchema: { customers: z.array(CustomerSchema), total: z.number() },
    },
    async ({ query, tier, country, limit, offset }) => {
      const q = query?.toLowerCase();
      const matches = world.customers.filter(
        (c) =>
          (!q || c.name.toLowerCase().includes(q) || c.company.toLowerCase().includes(q) || c.email.toLowerCase().includes(q)) &&
          (!tier || c.tier === tier) &&
          (!country || c.country.toLowerCase() === country.toLowerCase()),
      );
      return jsonResult({ customers: matches.slice(offset ?? 0, (offset ?? 0) + (limit ?? 50)), total: matches.length });
    },
  );

  s.tool(
    "crm_get_customer",
    {
      description: "Get a single customer account by ID.",
      inputSchema: { customer_id: z.string().describe("Customer ID, e.g. C017") },
      outputSchema: CustomerSchema.shape,
    },
    async ({ customer_id }) => jsonResult({ ...findCustomer(customer_id) }),
  );

  s.tool(
    "crm_update_customer",
    {
      description: "Update fields on a customer account. Only provided fields are changed. Returns the updated customer.",
      inputSchema: {
        customer_id: z.string(),
        tier: TierSchema.optional(),
        account_manager: z.string().optional().describe("Full name of a staff member with the account_manager role"),
        notes: z.string().optional(),
      },
      outputSchema: CustomerSchema.shape,
    },
    async ({ customer_id, tier, account_manager, notes }) => {
      const c = findCustomer(customer_id);
      if (account_manager !== undefined && !world.staff.some((m) => m.name === account_manager && m.role === "account_manager")) {
        throw new ToolInputError(`Unknown account manager: ${account_manager}`);
      }
      if (tier !== undefined) c.tier = tier;
      if (account_manager !== undefined) c.account_manager = account_manager;
      if (notes !== undefined) c.notes = notes;
      c.last_activity_at = world.now;
      return jsonResult({ ...c });
    },
  );

  s.tool(
    "crm_list_invoices",
    {
      description:
        "List invoices, optionally filtered by customer and/or status. " +
        "Returns at most `limit` invoices (default 100, max 500) starting at `offset`, plus the total number of matches.",
      inputSchema: {
        customer_id: z.string().optional(),
        status: InvoiceStatusSchema.optional(),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional().describe("Number of matching records to skip (for pagination, default 0)"),
      },
      outputSchema: { invoices: z.array(InvoiceSchema), total: z.number() },
    },
    async ({ customer_id, status, limit, offset }) => {
      const matches = world.invoices.filter((i) => (!customer_id || i.customer_id === customer_id) && (!status || i.status === status));
      return jsonResult({ invoices: matches.slice(offset ?? 0, (offset ?? 0) + (limit ?? 100)), total: matches.length });
    },
  );

  s.tool(
    "crm_update_invoice",
    {
      description: "Change the status of an invoice. Returns the updated invoice.",
      inputSchema: { invoice_id: z.string().describe("Invoice ID, e.g. INV-0042"), status: InvoiceStatusSchema },
      outputSchema: InvoiceSchema.shape,
    },
    async ({ invoice_id, status }) => {
      const inv = world.invoices.find((i) => i.id === invoice_id);
      if (!inv) throw new ToolInputError(`Invoice not found: ${invoice_id}`);
      inv.status = status;
      return jsonResult({ ...inv });
    },
  );

  return { name: "crm", server: s.server, tools: s.registered };
}
