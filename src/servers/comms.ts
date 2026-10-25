import { z } from "zod";
import type { World } from "../world/types.js";
import { FilteredServer, type ServerFactoryResult } from "./registry.js";
import { EventSchema, StaffSchema, ToolInputError, jsonResult } from "./schemas.js";

export const COMMS_TOOLS = ["calendar_list_events", "calendar_create_event", "email_send", "directory_list_staff"] as const;

const isIso = (s: string) => !Number.isNaN(Date.parse(s));

export function createCommsServer(world: World, allowed?: ReadonlySet<string>): ServerFactoryResult {
  const s = new FilteredServer("comms", allowed);

  s.tool(
    "calendar_list_events",
    {
      description:
        "List calendar events, sorted by start time. `from`/`to` are ISO 8601 bounds on the event start (inclusive/exclusive). " +
        "`attendee` filters to events that include this email address.",
      inputSchema: {
        from: z.string().optional(),
        to: z.string().optional(),
        attendee: z.string().optional(),
      },
      outputSchema: { events: z.array(EventSchema) },
    },
    async ({ from, to, attendee }) => {
      if ((from && !isIso(from)) || (to && !isIso(to))) throw new ToolInputError("`from` and `to` must be ISO 8601 timestamps");
      const lo = from ? Date.parse(from) : -Infinity;
      const hi = to ? Date.parse(to) : Infinity;
      const a = attendee?.toLowerCase();
      const events = world.events
        .filter((e) => {
          const t = Date.parse(e.start);
          return t >= lo && t < hi && (!a || e.attendees.some((x) => x.toLowerCase() === a));
        })
        .sort((x, y) => x.start.localeCompare(y.start));
      return jsonResult({ events });
    },
  );

  s.tool(
    "calendar_create_event",
    {
      description: "Create a calendar event. Times must be ISO 8601 in UTC. Returns the created event.",
      inputSchema: {
        title: z.string(),
        start: z.string(),
        end: z.string(),
        attendees: z.array(z.string()).describe("Attendee email addresses"),
        location: z.string().optional(),
      },
      outputSchema: EventSchema.shape,
    },
    async ({ title, start, end, attendees, location }) => {
      if (!isIso(start) || !isIso(end)) throw new ToolInputError("`start` and `end` must be ISO 8601 timestamps");
      if (Date.parse(end) <= Date.parse(start)) throw new ToolInputError("`end` must be after `start`");
      world.counters.event += 1;
      const event = {
        id: `EV${String(world.counters.event).padStart(3, "0")}`,
        title,
        start: new Date(start).toISOString(),
        end: new Date(end).toISOString(),
        attendees,
        location: location ?? "Video call",
      };
      world.events.push(event);
      return jsonResult({ ...event });
    },
  );

  s.tool(
    "email_send",
    {
      description: "Send an email from the operations team mailbox.",
      inputSchema: {
        to: z.array(z.string()).min(1).describe("Recipient email addresses"),
        subject: z.string(),
        body: z.string(),
      },
      outputSchema: { id: z.string(), sent_at: z.string() },
    },
    async ({ to, subject, body }) => {
      world.counters.email += 1;
      const email = { id: `EM${String(world.counters.email).padStart(4, "0")}`, to, subject, body, sent_at: world.now };
      world.outbox.push(email);
      return jsonResult({ id: email.id, sent_at: email.sent_at });
    },
  );

  s.tool(
    "directory_list_staff",
    {
      description: "List internal staff members with their email addresses and roles.",
      inputSchema: {},
      outputSchema: { staff: z.array(StaffSchema) },
    },
    async () => jsonResult({ staff: world.staff }),
  );

  return { name: "comms", server: s.server, tools: s.registered };
}
