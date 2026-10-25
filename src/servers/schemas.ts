import { z } from "zod";

/**
 * Zod schemas shared by the simulated MCP servers. They double as MCP
 * `outputSchema`s, so Code Mode can generate precise return types.
 */

export const TierSchema = z.enum(["free", "pro", "enterprise"]);
export const InvoiceStatusSchema = z.enum(["paid", "open", "overdue"]);
export const TicketPrioritySchema = z.enum(["low", "normal", "high", "urgent"]);
export const TicketStatusSchema = z.enum(["open", "pending", "closed"]);

export const CustomerSchema = z.object({
  id: z.string().describe("Customer ID, e.g. C017"),
  name: z.string().describe("Primary contact name"),
  email: z.string(),
  phone: z.string(),
  company: z.string(),
  tier: TierSchema,
  country: z.string(),
  account_manager: z.string().describe("Name of the assigned account manager"),
  created_at: z.string().describe("ISO 8601 timestamp"),
  last_activity_at: z.string(),
  lifecycle_stage: z.enum(["onboarding", "active", "at_risk", "renewal"]),
  notes: z.string(),
  address: z.object({ street: z.string(), city: z.string(), postal_code: z.string(), country: z.string() }),
});

export const InvoiceSchema = z.object({
  id: z.string().describe("Invoice ID, e.g. INV-0042"),
  customer_id: z.string(),
  amount: z.number().describe("Total amount in USD"),
  currency: z.literal("USD"),
  status: InvoiceStatusSchema,
  issued_at: z.string(),
  due_at: z.string(),
  line_items: z.array(z.object({ description: z.string(), quantity: z.number(), unit_price: z.number() })),
});

export const TicketSchema = z.object({
  id: z.string().describe("Ticket ID, e.g. T0123"),
  customer_id: z.string(),
  subject: z.string(),
  body: z.string(),
  priority: TicketPrioritySchema,
  status: TicketStatusSchema,
  assignee: z.string().nullable().describe("Support agent name, or null if unassigned"),
  tags: z.array(z.string()),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.array(z.object({ author: z.string(), body: z.string(), created_at: z.string() })),
});

export const StaffSchema = z.object({
  name: z.string(),
  email: z.string(),
  role: z.enum(["account_manager", "support_agent", "support_lead"]),
});

export const EventSchema = z.object({
  id: z.string(),
  title: z.string(),
  start: z.string().describe("ISO 8601 start time (UTC)"),
  end: z.string().describe("ISO 8601 end time (UTC)"),
  attendees: z.array(z.string()).describe("Attendee email addresses"),
  location: z.string(),
});

/** Build a tool result carrying both a JSON text block and structured content. */
export function jsonResult<T extends Record<string, unknown>>(data: T) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data) }],
    structuredContent: data,
  };
}

export class ToolInputError extends Error {}
