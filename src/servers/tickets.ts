import { z } from "zod";
import type { World } from "../world/types.js";
import { FilteredServer, type ServerFactoryResult } from "./registry.js";
import { TicketPrioritySchema, TicketSchema, TicketStatusSchema, ToolInputError, jsonResult } from "./schemas.js";

export const TICKET_TOOLS = ["tickets_search", "tickets_get", "tickets_create", "tickets_update", "tickets_add_comment"] as const;

export function createTicketsServer(world: World, allowed?: ReadonlySet<string>): ServerFactoryResult {
  const s = new FilteredServer("tickets", allowed);

  const findTicket = (id: string) => {
    const t = world.tickets.find((x) => x.id === id);
    if (!t) throw new ToolInputError(`Ticket not found: ${id}`);
    return t;
  };
  const touch = (t: { updated_at: string }) => {
    t.updated_at = world.now;
  };

  s.tool(
    "tickets_search",
    {
      description:
        "Search support tickets. All filters are optional and combined with AND. " +
        "Results include the full ticket body and comments, newest first. " +
        "Returns at most `limit` tickets (default 50, max 500) starting at `offset`, plus the total number of matches.",
      inputSchema: {
        status: TicketStatusSchema.optional(),
        priority: TicketPrioritySchema.optional(),
        customer_id: z.string().optional(),
        tag: z.string().optional().describe("Return tickets that carry this tag"),
        assignee: z.string().optional().describe("Support agent name"),
        limit: z.number().int().min(1).max(500).optional(),
        offset: z.number().int().min(0).optional().describe("Number of matching records to skip (for pagination, default 0)"),
      },
      outputSchema: { tickets: z.array(TicketSchema), total: z.number() },
    },
    async ({ status, priority, customer_id, tag, assignee, limit, offset }) => {
      const matches = world.tickets
        .filter(
          (t) =>
            (!status || t.status === status) &&
            (!priority || t.priority === priority) &&
            (!customer_id || t.customer_id === customer_id) &&
            (!tag || t.tags.includes(tag)) &&
            (!assignee || t.assignee === assignee),
        )
        .sort((a, b) => b.created_at.localeCompare(a.created_at));
      return jsonResult({ tickets: matches.slice(offset ?? 0, (offset ?? 0) + (limit ?? 50)), total: matches.length });
    },
  );

  s.tool(
    "tickets_get",
    {
      description: "Get a single ticket by ID, including its comments.",
      inputSchema: { ticket_id: z.string().describe("Ticket ID, e.g. T0123") },
      outputSchema: TicketSchema.shape,
    },
    async ({ ticket_id }) => jsonResult({ ...findTicket(ticket_id) }),
  );

  s.tool(
    "tickets_create",
    {
      description: "Create a new support ticket for a customer. New tickets start with status 'open' and no assignee.",
      inputSchema: {
        customer_id: z.string(),
        subject: z.string(),
        body: z.string(),
        priority: TicketPrioritySchema,
        tags: z.array(z.string()).optional(),
      },
      outputSchema: TicketSchema.shape,
    },
    async ({ customer_id, subject, body, priority, tags }) => {
      if (!world.customers.some((c) => c.id === customer_id)) throw new ToolInputError(`Customer not found: ${customer_id}`);
      world.counters.ticket += 1;
      const ticket = {
        id: `T${String(world.counters.ticket).padStart(4, "0")}`,
        customer_id,
        subject,
        body,
        priority,
        status: "open" as const,
        assignee: null,
        tags: tags ?? [],
        created_at: world.now,
        updated_at: world.now,
        comments: [],
      };
      world.tickets.push(ticket);
      return jsonResult({ ...ticket });
    },
  );

  s.tool(
    "tickets_update",
    {
      description:
        "Update a ticket. Only provided fields are changed. `add_tags` appends tags that are not already present. " +
        "Set `assignee` to a support agent's full name. Returns the updated ticket.",
      inputSchema: {
        ticket_id: z.string(),
        status: TicketStatusSchema.optional(),
        priority: TicketPrioritySchema.optional(),
        assignee: z.string().optional(),
        add_tags: z.array(z.string()).optional(),
      },
      outputSchema: TicketSchema.shape,
    },
    async ({ ticket_id, status, priority, assignee, add_tags }) => {
      const t = findTicket(ticket_id);
      if (assignee !== undefined && !world.staff.some((m) => m.name === assignee)) throw new ToolInputError(`Unknown staff member: ${assignee}`);
      if (status !== undefined) t.status = status;
      if (priority !== undefined) t.priority = priority;
      if (assignee !== undefined) t.assignee = assignee;
      for (const tag of add_tags ?? []) if (!t.tags.includes(tag)) t.tags.push(tag);
      touch(t);
      return jsonResult({ ...t });
    },
  );

  s.tool(
    "tickets_add_comment",
    {
      description: "Add a comment to a ticket on behalf of the operations team. Returns the updated ticket.",
      inputSchema: { ticket_id: z.string(), body: z.string() },
      outputSchema: TicketSchema.shape,
    },
    async ({ ticket_id, body }) => {
      const t = findTicket(ticket_id);
      t.comments.push({ author: "Operations Assistant", body, created_at: world.now });
      touch(t);
      return jsonResult({ ...t });
    },
  );

  return { name: "tickets", server: s.server, tools: s.registered };
}
