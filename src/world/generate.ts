import type {
  CalendarEvent,
  Customer,
  Invoice,
  InvoiceStatus,
  StaffMember,
  Ticket,
  TicketPriority,
  TicketStatus,
  Tier,
  World,
} from "./types.js";

/** Default dataset seed. Changing it changes every task's expected answer. */
export const DEFAULT_WORLD_SEED = 1337;
export const WORLD_NOW = "2026-03-15T09:00:00.000Z";

/** mulberry32: small, fast, deterministic PRNG. */
export function createRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int(min: number, max: number) {
      return Math.floor(next() * (max - min + 1)) + min;
    },
    pick<T>(items: readonly T[]): T {
      return items[Math.floor(next() * items.length)]!;
    },
    weighted<T>(entries: readonly (readonly [T, number])[]): T {
      const total = entries.reduce((s, [, w]) => s + w, 0);
      let r = next() * total;
      for (const [value, w] of entries) {
        r -= w;
        if (r <= 0) return value;
      }
      return entries[entries.length - 1]![0];
    },
    sample<T>(items: readonly T[], n: number): T[] {
      const copy = [...items];
      const out: T[] = [];
      while (out.length < n && copy.length > 0) {
        out.push(copy.splice(Math.floor(next() * copy.length), 1)[0]!);
      }
      return out;
    },
  };
}
export type Rng = ReturnType<typeof createRng>;

const FIRST_NAMES = [
  "Ava", "Liam", "Maya", "Noah", "Priya", "Lucas", "Sofia", "Ethan", "Aisha", "Mateo",
  "Hannah", "Arjun", "Chloe", "Kenji", "Isabel", "Omar", "Elena", "Jonas", "Zara", "Diego",
  "Leah", "Ravi", "Freya", "Hugo", "Mei", "Samuel", "Nora", "Tariq", "Clara", "Felix",
] as const;
const LAST_NAMES = [
  "Patel", "Schmidt", "Garcia", "Nguyen", "Okafor", "Rossi", "Kowalski", "Tanaka", "Silva", "Murphy",
  "Andersen", "Khan", "Dubois", "Larsen", "Mehta", "Novak", "Fischer", "Costa", "Ibrahim", "Walsh",
] as const;
const COMPANY_STEMS = [
  "Northwind", "Bluepeak", "Ironleaf", "Suncrest", "Quantia", "Harborview", "Pinegate", "Lumen",
  "Redwood", "Stellar", "Brightwave", "Cobalt", "Meridian", "Oakline", "Silverline", "Tidewater",
  "Vertex", "Willow", "Zephyr", "Arcadia", "Beacon", "Cascade", "Driftwood", "Evergreen",
] as const;
const COMPANY_SUFFIXES = ["Labs", "Logistics", "Health", "Analytics", "Foods", "Robotics", "Media", "Energy", "Retail", "Systems"] as const;
const COUNTRIES = [
  ["United States", 24], ["Germany", 12], ["India", 12], ["Canada", 10], ["United Kingdom", 10],
  ["France", 8], ["Brazil", 7], ["Japan", 6], ["Australia", 6], ["Netherlands", 5],
] as const;
const CITIES: Record<string, string[]> = {
  "United States": ["Austin", "Denver", "Seattle", "Boston"],
  Germany: ["Berlin", "Munich", "Hamburg"],
  India: ["Bengaluru", "Pune", "Hyderabad"],
  Canada: ["Toronto", "Vancouver", "Montreal"],
  "United Kingdom": ["London", "Manchester", "Leeds"],
  France: ["Paris", "Lyon"],
  Brazil: ["São Paulo", "Curitiba"],
  Japan: ["Tokyo", "Osaka"],
  Australia: ["Sydney", "Melbourne"],
  Netherlands: ["Amsterdam", "Utrecht"],
};

const STAFF: StaffMember[] = [
  { name: "Grace Holloway", email: "grace.holloway@acme-ops.example", role: "account_manager" },
  { name: "Marcus Webb", email: "marcus.webb@acme-ops.example", role: "account_manager" },
  { name: "Ananya Rao", email: "ananya.rao@acme-ops.example", role: "account_manager" },
  { name: "Tom Becker", email: "tom.becker@acme-ops.example", role: "account_manager" },
  { name: "Lena Park", email: "lena.park@acme-ops.example", role: "support_agent" },
  { name: "Daniel Osei", email: "daniel.osei@acme-ops.example", role: "support_agent" },
  { name: "Ines Moreau", email: "ines.moreau@acme-ops.example", role: "support_agent" },
  { name: "Victor Hale", email: "victor.hale@acme-ops.example", role: "support_agent" },
  { name: "Ruth Adeyemi", email: "ruth.adeyemi@acme-ops.example", role: "support_lead" },
];
export const ACCOUNT_MANAGERS = STAFF.filter((s) => s.role === "account_manager").map((s) => s.name);
export const SUPPORT_AGENTS = STAFF.filter((s) => s.role === "support_agent").map((s) => s.name);

const TICKET_TOPICS = {
  billing: {
    subjects: ["Invoice amount looks wrong", "Charged twice this month", "Need a copy of last invoice", "Refund request for unused seats"],
    detail: "Our finance team reconciled the latest statement and the totals do not match the contract. We were billed for more seats than we have provisioned, and the proration for the mid-cycle upgrade is missing.",
  },
  login: {
    subjects: ["Users cannot log in", "SSO redirect loop", "Password reset emails not arriving", "MFA codes rejected"],
    detail: "Several users report that authentication fails after the identity provider redirects back to the application. Clearing cookies does not help and the problem affects both desktop and mobile browsers.",
  },
  performance: {
    subjects: ["Dashboard loads slowly", "API latency spikes", "Reports time out", "Search is very slow"],
    detail: "Since the last release, page load times have increased from roughly two seconds to more than fifteen. The slowdown is worst during business hours and affects the reporting module the most.",
  },
  integration: {
    subjects: ["Webhook deliveries failing", "Salesforce sync stopped", "Slack notifications missing", "API key rotation broke integration"],
    detail: "The integration stopped delivering events without any configuration change on our side. The delivery log shows repeated 5xx responses and the retry queue keeps growing.",
  },
  "feature-request": {
    subjects: ["Request: bulk export", "Request: custom roles", "Request: audit log filters", "Request: dark mode"],
    detail: "Our administrators would benefit from this capability because the current workaround requires manual steps every week. Several teams have asked for it during our internal review.",
  },
  "data-export": {
    subjects: ["CSV export missing columns", "Export job stuck", "Need full data export for audit", "Export encoding issue"],
    detail: "The export completes but the resulting file is missing fields that are visible in the user interface. Our auditors need the complete dataset by the end of the month.",
  },
  security: {
    subjects: ["Suspicious login alerts", "Question about data retention", "Need SOC 2 report", "Report of exposed API token"],
    detail: "Our security team flagged activity that needs review. Please confirm what data is retained, for how long, and which controls are in place to detect unauthorised access.",
  },
} as const;
type TopicTag = keyof typeof TICKET_TOPICS;
const TOPIC_TAGS = Object.keys(TICKET_TOPICS) as TopicTag[];

const pad = (n: number, width: number) => String(n).padStart(width, "0");
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

function isoDay(base: Date, offsetDays: number, hour = 9, minute = 0): string {
  const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate() + offsetDays, hour, minute));
  return d.toISOString();
}
const addDays = (iso: string, days: number) => new Date(new Date(iso).getTime() + days * 86_400_000).toISOString();
const round2 = (n: number) => Math.round(n * 100) / 100;

export function generateWorld(seed: number = DEFAULT_WORLD_SEED): World {
  const rng = createRng(seed);
  const now = new Date(WORLD_NOW);

  // ---------------------------------------------------------------- customers
  const customers: Customer[] = [];
  const usedCompanies = new Set<string>();
  for (let i = 1; i <= 120; i++) {
    let company = "";
    do {
      company = `${rng.pick(COMPANY_STEMS)} ${rng.pick(COMPANY_SUFFIXES)}`;
    } while (usedCompanies.has(company));
    usedCompanies.add(company);
    const first = rng.pick(FIRST_NAMES);
    const last = rng.pick(LAST_NAMES);
    const country = rng.weighted(COUNTRIES);
    const tier: Tier = rng.weighted([["free", 45], ["pro", 35], ["enterprise", 20]] as const);
    const domain = rng.next() < 0.15 ? "example.org" : `${slug(company)}.example`;
    const createdOffset = -rng.int(20, 900);
    customers.push({
      id: `C${pad(i, 3)}`,
      name: `${first} ${last}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}${domain === "example.org" ? i : ""}@${domain}`,
      phone: `+1-555-${pad(rng.int(100, 999), 3)}-${pad(rng.int(0, 9999), 4)}`,
      company,
      tier,
      country,
      account_manager: rng.pick(ACCOUNT_MANAGERS),
      created_at: isoDay(now, createdOffset, rng.int(8, 17)),
      last_activity_at: isoDay(now, -rng.int(0, 60), rng.int(8, 17)),
      lifecycle_stage: rng.weighted([["onboarding", 10], ["active", 60], ["at_risk", 15], ["renewal", 15]] as const),
      notes: rng.next() < 0.3 ? "Prefers email over phone. Quarterly business reviews requested." : "",
      address: {
        street: `${rng.int(1, 999)} ${rng.pick(["Market", "Harbor", "King", "Station", "Park", "Mill"])} ${rng.pick(["Street", "Avenue", "Road"])}`,
        city: rng.pick(CITIES[country]!),
        postal_code: pad(rng.int(1000, 99999), 5),
        country,
      },
    });
  }

  // ----------------------------------------------------------------- invoices
  const invoices: Invoice[] = [];
  let invoiceSeq = 1;
  for (const c of customers) {
    const count = rng.int(2, 5);
    for (let k = 0; k < count; k++) {
      const issued = isoDay(now, -rng.int(5, 270));
      const due = addDays(issued, 30);
      const isPastDue = new Date(due) < now;
      const status: InvoiceStatus = isPastDue
        ? rng.weighted([["paid", 72], ["overdue", 28]] as const)
        : rng.weighted([["open", 75], ["paid", 25]] as const);
      const seats = rng.int(1, c.tier === "enterprise" ? 200 : c.tier === "pro" ? 40 : 5);
      const unit = c.tier === "enterprise" ? 45 : c.tier === "pro" ? 25 : 9;
      const support = c.tier === "enterprise" ? round2(rng.int(200, 1500) + rng.next()) : 0;
      const line_items = [{ description: `Platform seats (${c.tier})`, quantity: seats, unit_price: unit }];
      if (support > 0) line_items.push({ description: "Premium support", quantity: 1, unit_price: support });
      invoices.push({
        id: `INV-${pad(invoiceSeq++, 4)}`,
        customer_id: c.id,
        amount: round2(line_items.reduce((s, li) => s + li.quantity * li.unit_price, 0)),
        currency: "USD",
        status,
        issued_at: issued,
        due_at: due,
        line_items,
      });
    }
  }

  // ------------------------------------------------------------------ tickets
  const tickets: Ticket[] = [];
  for (let i = 1; i <= 400; i++) {
    const customer = rng.pick(customers);
    const tag = rng.pick(TOPIC_TAGS);
    const topic = TICKET_TOPICS[tag];
    const status: TicketStatus = rng.weighted([["closed", 50], ["open", 30], ["pending", 20]] as const);
    const priority: TicketPriority = rng.weighted([["low", 20], ["normal", 45], ["high", 25], ["urgent", 10]] as const);
    const created = isoDay(now, -rng.int(1, 180), rng.int(7, 19), rng.int(0, 59));
    const unassigned = status !== "closed" && rng.next() < 0.18;
    const tags: string[] = [tag];
    if (rng.next() < 0.3) {
      const extra = rng.pick(TOPIC_TAGS);
      if (extra !== tag) tags.push(extra);
    }
    const assignee = unassigned ? null : rng.pick(SUPPORT_AGENTS);
    const comments = Array.from({ length: rng.int(0, 3) }, (_, k) => ({
      author: k % 2 === 0 ? (assignee ?? rng.pick(SUPPORT_AGENTS)) : customer.name,
      body: k % 2 === 0
        ? "Thanks for the report. We are reviewing the logs and will follow up shortly with next steps."
        : "Any update on this? The issue is still affecting our team.",
      created_at: addDays(created, k + 1),
    }));
    tickets.push({
      id: `T${pad(i, 4)}`,
      customer_id: customer.id,
      subject: rng.pick(topic.subjects),
      body: `Hello support team,\n\n${topic.detail} This started on ${created.slice(0, 10)} and is impacting ${rng.int(2, 80)} users at ${customer.company}. ${topic.detail}\n\nAccount: ${customer.company} (${customer.id}). Please advise on next steps and expected timelines.\n\nBest regards,\n${customer.name}`,
      priority,
      status,
      assignee,
      tags,
      created_at: created,
      updated_at: comments.length ? comments[comments.length - 1]!.created_at : created,
      comments,
    });
  }

  // ------------------------------------------------------------------- events
  const events: CalendarEvent[] = [];
  const monday = new Date(Date.UTC(2026, 2, 9));
  let eventSeq = 1;
  const pushEvent = (title: string, start: string, minutes: number, attendees: string[], location: string) => {
    events.push({ id: `EV${pad(eventSeq++, 3)}`, title, start, end: new Date(new Date(start).getTime() + minutes * 60_000).toISOString(), attendees, location });
  };
  for (let d = 0; d < 19; d++) {
    const day = new Date(monday.getTime() + d * 86_400_000);
    if (day.getUTCDay() === 0 || day.getUTCDay() === 6) continue;
    pushEvent("Support standup", isoDay(monday, d, 8, 30), 15, STAFF.filter((s) => s.role !== "account_manager").map((s) => s.email), "Video call");
    const meetings = rng.int(1, 3);
    for (let m = 0; m < meetings; m++) {
      const c = rng.pick(customers);
      const manager = STAFF.find((s) => s.name === c.account_manager)!;
      const kind = rng.pick(["Quarterly review with", "Onboarding session:", "Renewal discussion with", "Technical deep dive with"] as const);
      pushEvent(`${kind} ${c.company}`, isoDay(monday, d, rng.int(10, 16), rng.pick([0, 30])), rng.pick([30, 45, 60]), [c.email, manager.email], "Video call");
    }
  }

  // -------------------------------------------------------------------- files
  const vip = rng.sample(customers, 12);
  const files: Record<string, string> = {
    "/exports/vip_list.csv": ["customer_id,company,added_on", ...vip.map((c) => `${c.id},${c.company},${c.created_at.slice(0, 10)}`)].join("\n") + "\n",
    "/exports/accounts_snapshot.csv": ["customer_id,company,tier,country,account_manager", ...customers.map((c) => `${c.id},${c.company},${c.tier},${c.country},${c.account_manager}`)].join("\n") + "\n",
    "/policies/escalation.md": [
      "# Ticket escalation policy",
      "",
      "Effective 2026-01-01. Applies to all tickets that are not closed (status `open` or `pending`).",
      "",
      "1. Tickets from **enterprise** customers with priority `high` must be escalated to priority `urgent`.",
      "2. Tickets from **pro** or **free** customers keep their current priority.",
      "3. Escalation does not change the assignee.",
      "",
    ].join("\n"),
    "/policies/refunds.md": "# Refund policy\n\nRefunds for unused seats are issued as account credit within 14 days. Annual plans are refundable pro rata within the first 30 days.\n",
    "/policies/sla.md": "# Support SLA\n\n| Priority | First response |\n|---|---|\n| urgent | 1 hour |\n| high | 4 hours |\n| normal | 1 business day |\n| low | 3 business days |\n",
    "/reports/2026-01-ops-review.md": "# January operations review\n\nTicket volume rose 8% month over month, driven by login issues after the SSO migration. Project Borealis (self-serve billing) slipped to Q2.\n",
    "/reports/2026-02-ops-review.md": "# February operations review\n\nMedian first response time improved to 2.1 hours. Data export complaints remain the top driver of escalations.\n",
    "/reports/q1-initiatives.md": "# Q1 initiatives\n\n- Migrate reporting to the new warehouse.\n- Project Atlas: consolidate all customer notifications into a single delivery service, owned by the platform team.\n- Reduce urgent ticket backlog by 30%.\n",
    "/reports/hiring-plan.md": "# Hiring plan\n\nTwo additional support agents for the EMEA shift and one solutions engineer for enterprise onboarding.\n",
    "/README.txt": "Shared drive for the customer operations team. Exports are regenerated nightly.\n",
  };

  return {
    now: WORLD_NOW,
    seed,
    customers,
    invoices,
    tickets,
    staff: STAFF.map((s) => ({ ...s })),
    events,
    outbox: [],
    files,
    counters: { ticket: tickets.length, event: events.length, email: 0 },
  };
}

export function cloneWorld(world: World): World {
  return structuredClone(world);
}
