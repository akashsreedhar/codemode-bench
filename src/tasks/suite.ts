import type { Customer, Ticket, World } from "../world/types.js";
import { defineTask, type TaskDefinition, type VerifyContext } from "./types.js";
import {
  all,
  checkContains,
  checkContainsAll,
  checkIdSet,
  checkMentions,
  checkNumber,
  checkOneOf,
  compareSets,
  fail,
  idsIn,
  keyedNumber,
  norm,
  ok,
  round,
  type Verification,
} from "./verify.js";

// ------------------------------------------------------------------ helpers

const j = (v: unknown) => JSON.stringify(v);
const CUSTOMER_ID = /\bC\d{3}\b/;
const TICKET_ID = /\bT\d{4}\b/;
const TOPIC_TAGS = ["billing", "login", "performance", "integration", "feature-request", "data-export", "security"];

const customer = (w: World, id: string): Customer => w.customers.find((c) => c.id === id)!;
const ticket = (w: World, id: string): Ticket => w.tickets.find((t) => t.id === id)!;
const isActive = (t: Ticket) => t.status !== "closed";
const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
const overdueInvoices = (w: World) => w.invoices.filter((i) => i.status === "overdue");
const customersWithOverdue = (w: World) => new Set(overdueInvoices(w).map((i) => i.customer_id));
const staffEmail = (w: World, name: string) => w.staff.find((s) => s.name === name)!.email;

function newTickets(ctx: VerifyContext<unknown>): Ticket[] {
  const before = new Set(ctx.initial.tickets.map((t) => t.id));
  return ctx.final.tickets.filter((t) => !before.has(t.id));
}

/** IDs of pre-existing tickets whose content changed during the run. */
function changedTickets(ctx: VerifyContext<unknown>, fields?: (keyof Ticket)[]): Set<string> {
  const out = new Set<string>();
  for (const before of ctx.initial.tickets) {
    const after = ticket(ctx.final, before.id);
    const pick = (t: Ticket) => (fields ? fields.map((f) => t[f]) : { ...t, updated_at: undefined });
    if (JSON.stringify(pick(before)) !== JSON.stringify(pick(after))) out.add(before.id);
  }
  return out;
}

function onlyChanged(ctx: VerifyContext<unknown>, allowed: Set<string>): Verification {
  const unexpected = [...changedTickets(ctx)].filter((id) => !allowed.has(id));
  return unexpected.length === 0 ? ok("no unrelated tickets modified") : fail(`unrelated tickets modified: ${unexpected.slice(0, 10).join(", ")}`, 0.5);
}

/** Pick the most common value; returns every value tied for first place. */
function modes(values: string[]): string[] {
  const counts = new Map<string, number>();
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1);
  const max = Math.max(...counts.values());
  return [...counts.entries()].filter(([, n]) => n === max).map(([v]) => v).sort();
}

function checkIdOneOf(answer: string, acceptable: string[], pattern: RegExp): Verification {
  const found = [...idsIn(answer, pattern)];
  if (found.length > 0 && found.every((f) => acceptable.includes(f))) return ok(`answered ${found.join(", ")}`);
  return fail(`expected one of [${acceptable.join(", ")}], found [${found.join(", ")}]`);
}

function checkDateTime(answer: string, iso: string): Verification {
  const date = iso.slice(0, 10);
  const time = iso.slice(11, 16);
  return answer.includes(date) && answer.includes(time) ? ok(`found ${date} ${time}`) : fail(`expected ${date} ${time}`);
}

// -------------------------------------------------------------------- tasks

export const TASKS: TaskDefinition<any>[] = [
  // ===================================================== lookup
  defineTask({
    id: "lookup-customer-email",
    title: "Look up a customer's email address",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["crm_get_customer"],
    pilot: true,
    params: (w) => ({ id: "C017", email: customer(w, "C017").email }),
    prompt: (p) => `What is the email address of customer ${p.id}?`,
    verify: ({ params, answer }) => checkContains(answer, params.email),
    oracle: (p) => `const c = await codemode.crm_get_customer({ customer_id: ${j(p.id)} });\nreturn c.email;`,
  }),
  defineTask({
    id: "lookup-company-country",
    title: "Find the country of a company by name",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["crm_search_customers"],
    params: (w) => ({ company: customer(w, "C042").company, country: customer(w, "C042").country }),
    prompt: (p) => `Which country is the customer account "${p.company}" based in?`,
    verify: ({ params, answer }) => checkContains(answer, params.country),
    oracle: (p) => `const r = await codemode.crm_search_customers({ query: ${j(p.company)} });\nreturn r.customers.find((c) => c.company === ${j(p.company)}).country;`,
  }),
  defineTask({
    id: "lookup-ticket-status",
    title: "Check the status of a ticket",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["tickets_get"],
    params: (w) => ({ id: "T0123", status: ticket(w, "T0123").status }),
    prompt: (p) => `What is the current status of support ticket ${p.id}? Answer with the status only.`,
    verify: ({ params, answer }) => checkMentions(answer, ["open", "pending", "closed"], [params.status]),
    oracle: (p) => `const t = await codemode.tickets_get({ ticket_id: ${j(p.id)} });\nreturn t.status;`,
  }),
  defineTask({
    id: "lookup-ticket-account-manager",
    title: "Find the account manager behind a ticket",
    category: "lookup",
    chain: "short",
    payload: "small",
    requiredTools: ["tickets_get", "crm_get_customer"],
    pilot: true,
    params: (w) => ({ id: "T0200", manager: customer(w, ticket(w, "T0200").customer_id).account_manager }),
    prompt: (p) => `Who is the account manager for the customer who opened ticket ${p.id}?`,
    verify: ({ params, answer }) => checkContains(answer, params.manager),
    oracle: (p) =>
      `const t = await codemode.tickets_get({ ticket_id: ${j(p.id)} });\nconst c = await codemode.crm_get_customer({ customer_id: t.customer_id });\nreturn c.account_manager;`,
  }),
  defineTask({
    id: "lookup-ticket-tags",
    title: "List the tags on a ticket",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["tickets_get"],
    params: (w) => ({ id: "T0300", tags: ticket(w, "T0300").tags }),
    prompt: (p) => `Which tags are on ticket ${p.id}?`,
    verify: ({ params, answer }) => checkMentions(answer, TOPIC_TAGS, params.tags),
    oracle: (p) => `const t = await codemode.tickets_get({ ticket_id: ${j(p.id)} });\nreturn t.tags.join(", ");`,
  }),
  defineTask({
    id: "lookup-manager-email",
    title: "Find a customer's account manager email",
    category: "lookup",
    chain: "short",
    payload: "small",
    requiredTools: ["crm_get_customer", "directory_list_staff"],
    params: (w) => ({ id: "C055", email: staffEmail(w, customer(w, "C055").account_manager) }),
    prompt: (p) => `What is the email address of the account manager responsible for customer ${p.id}?`,
    verify: ({ params, answer }) => checkContains(answer, params.email),
    oracle: (p) =>
      `const c = await codemode.crm_get_customer({ customer_id: ${j(p.id)} });\nconst s = await codemode.directory_list_staff({});\nreturn s.staff.find((m) => m.name === c.account_manager).email;`,
  }),
  defineTask({
    id: "lookup-file-mention",
    title: "Find the document that mentions a project",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["files_search"],
    params: () => ({ path: "/reports/q1-initiatives.md" }),
    prompt: () => `Which file on the shared drive mentions "Project Atlas"? Give its path.`,
    verify: ({ params, answer }) => checkContains(answer, params.path),
    oracle: () => `const r = await codemode.files_search({ query: "Project Atlas" });\nreturn r.matches[0].path;`,
  }),
  defineTask({
    id: "lookup-meetings-on-day",
    title: "List meetings on a given day",
    category: "lookup",
    chain: "single",
    payload: "small",
    requiredTools: ["calendar_list_events"],
    pilot: true,
    params: (w) => ({ titles: [...new Set(w.events.filter((e) => e.start.startsWith("2026-03-16")).map((e) => e.title))] }),
    prompt: () => `List the titles of all calendar events that start on 2026-03-16 (UTC).`,
    verify: ({ params, answer }) => checkContainsAll(answer, params.titles),
    oracle: () =>
      `const r = await codemode.calendar_list_events({ from: "2026-03-16T00:00:00Z", to: "2026-03-17T00:00:00Z" });\nreturn [...new Set(r.events.map((e) => e.title))].join("\\n");`,
  }),

  // ===================================================== aggregate
  defineTask({
    id: "aggregate-overdue-total",
    title: "Total of all overdue invoices",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_list_invoices"],
    pilot: true,
    params: (w) => ({ total: round(sum(overdueInvoices(w).map((i) => i.amount)), 2) }),
    prompt: () => `What is the total amount (USD) of all overdue invoices? Round to two decimals.`,
    verify: ({ params, answer }) => checkNumber(answer, params.total, 0.011),
    oracle: () =>
      `const r = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst total = r.invoices.reduce((s, i) => s + i.amount, 0);\nreturn total.toFixed(2);`,
  }),
  defineTask({
    id: "aggregate-enterprise-overdue",
    title: "Overdue total for enterprise customers",
    category: "aggregate",
    chain: "short",
    payload: "large",
    requiredTools: ["crm_search_customers", "crm_list_invoices"],
    pilot: true,
    params: (w) => {
      const ent = new Set(w.customers.filter((c) => c.tier === "enterprise").map((c) => c.id));
      return { total: round(sum(overdueInvoices(w).filter((i) => ent.has(i.customer_id)).map((i) => i.amount)), 2) };
    },
    prompt: () => `What is the total overdue invoice amount (USD) for enterprise-tier customers? Round to two decimals.`,
    verify: ({ params, answer }) => checkNumber(answer, params.total, 0.011),
    oracle: () =>
      `const c = await fetchAll("crm_search_customers", { tier: "enterprise" });\nconst ids = new Set(c.customers.map((x) => x.id));\nconst r = await fetchAll("crm_list_invoices", { status: "overdue" });\nreturn r.invoices.filter((i) => ids.has(i.customer_id)).reduce((s, i) => s + i.amount, 0).toFixed(2);`,
  }),
  defineTask({
    id: "aggregate-top-debtor",
    title: "Customer with the largest unpaid balance",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_list_invoices"],
    params: (w) => {
      const totals = new Map<string, number>();
      for (const i of w.invoices) if (i.status !== "paid") totals.set(i.customer_id, round((totals.get(i.customer_id) ?? 0) + i.amount, 2));
      const max = Math.max(...totals.values());
      return { ids: [...totals.entries()].filter(([, v]) => v === max).map(([k]) => k) };
    },
    prompt: () => `Which customer has the largest total of unpaid invoices (status open or overdue)? Reply with the customer ID.`,
    verify: ({ params, answer }) => checkIdOneOf(answer, params.ids, CUSTOMER_ID),
    oracle: () =>
      `const t = {};\nfor (const status of ["open", "overdue"]) {\n  const r = await fetchAll("crm_list_invoices", { status });\n  for (const i of r.invoices) t[i.customer_id] = (t[i.customer_id] || 0) + i.amount;\n}\nreturn Object.entries(t).sort((a, b) => b[1] - a[1])[0][0];`,
  }),
  defineTask({
    id: "aggregate-active-urgent",
    title: "Count urgent tickets that are not closed",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["tickets_search"],
    params: (w) => ({ count: w.tickets.filter((t) => t.priority === "urgent" && isActive(t)).length }),
    prompt: () => `How many urgent tickets are not closed (status open or pending)?`,
    verify: ({ params, answer }) => checkNumber(answer, params.count, 0),
    oracle: () =>
      `const a = await codemode.tickets_search({ priority: "urgent", status: "open", limit: 1 });\nconst b = await codemode.tickets_search({ priority: "urgent", status: "pending", limit: 1 });\nreturn String(a.total + b.total);`,
  }),
  defineTask({
    id: "aggregate-average-invoice-germany",
    title: "Average invoice amount for German customers",
    category: "aggregate",
    chain: "short",
    payload: "large",
    requiredTools: ["crm_search_customers", "crm_list_invoices"],
    params: (w) => {
      const de = new Set(w.customers.filter((c) => c.country === "Germany").map((c) => c.id));
      const inv = w.invoices.filter((i) => de.has(i.customer_id));
      return { avg: round(sum(inv.map((i) => i.amount)) / inv.length, 2) };
    },
    prompt: () => `What is the average invoice amount (USD) across all invoices of customers based in Germany? Round to two decimals.`,
    verify: ({ params, answer }) => checkNumber(answer, params.avg, 0.011),
    oracle: () =>
      `const c = await fetchAll("crm_search_customers", { country: "Germany" });\nconst ids = new Set(c.customers.map((x) => x.id));\nconst r = await fetchAll("crm_list_invoices", {});\nconst inv = r.invoices.filter((i) => ids.has(i.customer_id));\nreturn (inv.reduce((s, i) => s + i.amount, 0) / inv.length).toFixed(2);`,
  }),
  defineTask({
    id: "aggregate-manager-most-enterprise",
    title: "Account manager with the most enterprise accounts",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_search_customers"],
    params: (w) => ({
      names: modes(w.customers.filter((c) => c.tier === "enterprise").map((c) => c.account_manager)),
      vocabulary: w.staff.filter((s) => s.role === "account_manager").map((s) => s.name),
    }),
    prompt: () => `Which account manager manages the most enterprise-tier customers?`,
    verify: ({ params, answer }) => checkOneOf(answer, params.vocabulary, params.names),
    oracle: () =>
      `const r = await fetchAll("crm_search_customers", { tier: "enterprise" });\nconst n = {};\nfor (const c of r.customers) n[c.account_manager] = (n[c.account_manager] || 0) + 1;\nreturn Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];`,
  }),
  defineTask({
    id: "aggregate-billing-tickets-overdue-customers",
    title: "Billing tickets from customers with overdue invoices",
    category: "aggregate",
    chain: "long",
    payload: "large",
    requiredTools: ["tickets_search", "crm_list_invoices"],
    pilot: true,
    params: (w) => {
      const debtors = customersWithOverdue(w);
      return { count: w.tickets.filter((t) => t.tags.includes("billing") && debtors.has(t.customer_id)).length };
    },
    prompt: () => `How many support tickets tagged "billing" belong to customers who have at least one overdue invoice?`,
    verify: ({ params, answer }) => checkNumber(answer, params.count, 0),
    oracle: () =>
      `const inv = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst debtors = new Set(inv.invoices.map((i) => i.customer_id));\nconst t = await fetchAll("tickets_search", { tag: "billing" });\nreturn String(t.tickets.filter((x) => debtors.has(x.customer_id)).length);`,
  }),
  defineTask({
    id: "aggregate-customers-created-2025",
    title: "Customers created in 2025",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_search_customers"],
    params: (w) => ({ count: w.customers.filter((c) => c.created_at.startsWith("2025")).length }),
    prompt: () => `How many customer accounts were created during calendar year 2025?`,
    verify: ({ params, answer }) => checkNumber(answer, params.count, 0),
    oracle: () => `const r = await fetchAll("crm_search_customers", {});\nreturn String(r.customers.filter((c) => c.created_at.startsWith("2025")).length);`,
  }),
  defineTask({
    id: "aggregate-closed-percentage",
    title: "Share of tickets that are closed",
    category: "aggregate",
    chain: "short",
    payload: "small",
    requiredTools: ["tickets_search"],
    params: (w) => ({ pct: round((100 * w.tickets.filter((t) => t.status === "closed").length) / w.tickets.length, 1) }),
    prompt: () => `What percentage of all support tickets are closed? Round to one decimal place.`,
    verify: ({ params, answer }) => checkNumber(answer, params.pct, 0.051),
    oracle: () =>
      `const all = await codemode.tickets_search({ limit: 1 });\nconst closed = await codemode.tickets_search({ status: "closed", limit: 1 });\nreturn (100 * closed.total / all.total).toFixed(1) + "%";`,
  }),
  defineTask({
    id: "aggregate-country-most-enterprise",
    title: "Country with the most enterprise customers",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_search_customers"],
    params: (w) => ({
      countries: modes(w.customers.filter((c) => c.tier === "enterprise").map((c) => c.country)),
      vocabulary: [...new Set(w.customers.map((c) => c.country))],
    }),
    prompt: () => `Which country has the most enterprise-tier customers?`,
    verify: ({ params, answer }) => checkOneOf(answer, params.vocabulary, params.countries),
    oracle: () =>
      `const r = await fetchAll("crm_search_customers", { tier: "enterprise" });\nconst n = {};\nfor (const c of r.customers) n[c.country] = (n[c.country] || 0) + 1;\nreturn Object.entries(n).sort((a, b) => b[1] - a[1])[0][0];`,
  }),
  defineTask({
    id: "aggregate-february-invoices",
    title: "Count and total of invoices issued in February 2026",
    category: "aggregate",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_list_invoices"],
    params: (w) => {
      const feb = w.invoices.filter((i) => i.issued_at.startsWith("2026-02"));
      return { count: feb.length, total: round(sum(feb.map((i) => i.amount)), 2) };
    },
    prompt: () => `How many invoices were issued in February 2026, and what is their combined amount (USD)? Answer in the form count=<n>, total=<amount>.`,
    verify: ({ params, answer }) => {
      const count = keyedNumber(answer, "count");
      const total = keyedNumber(answer, "total");
      return all(
        count === params.count ? ok("count matches") : fail(`count: expected ${params.count}, got ${count}`),
        total !== undefined && Math.abs(total - params.total) <= 0.011 ? ok("total matches") : fail(`total: expected ${params.total}, got ${total}`),
      );
    },
    oracle: () =>
      `const r = await fetchAll("crm_list_invoices", {});\nconst feb = r.invoices.filter((i) => i.issued_at.startsWith("2026-02"));\nreturn "count=" + feb.length + ", total=" + feb.reduce((s, i) => s + i.amount, 0).toFixed(2);`,
  }),
  defineTask({
    id: "aggregate-agent-open-load",
    title: "Open tickets assigned to an agent",
    category: "aggregate",
    chain: "single",
    payload: "small",
    requiredTools: ["tickets_search"],
    params: (w) => ({ agent: "Lena Park", count: w.tickets.filter((t) => t.status === "open" && t.assignee === "Lena Park").length }),
    prompt: (p) => `How many tickets with status "open" are assigned to ${p.agent}?`,
    verify: ({ params, answer }) => checkNumber(answer, params.count, 0),
    oracle: (p) => `const r = await codemode.tickets_search({ status: "open", assignee: ${j(p.agent)}, limit: 1 });\nreturn String(r.total);`,
  }),

  // ===================================================== transform
  defineTask({
    id: "transform-vip-urgent",
    title: "VIP customers with active urgent or high-priority tickets",
    category: "transform",
    chain: "long",
    payload: "large",
    requiredTools: ["files_read", "tickets_search"],
    pilot: true,
    params: (w) => {
      const vip = w.files["/exports/vip_list.csv"]!.trim().split("\n").slice(1).map((l) => l.split(",")[0]!);
      const hot = new Set(w.tickets.filter((t) => isActive(t) && (t.priority === "urgent" || t.priority === "high")).map((t) => t.customer_id));
      return { ids: vip.filter((id) => hot.has(id)) };
    },
    prompt: () =>
      `Read /exports/vip_list.csv. Which of those customers currently have at least one ticket with priority "urgent" or "high" that is not closed? Reply with their customer IDs.`,
    verify: ({ params, answer }) => checkIdSet(answer, params.ids, CUSTOMER_ID),
    oracle: () =>
      `const f = await codemode.files_read({ path: "/exports/vip_list.csv" });\nconst vip = f.content.trim().split("\\n").slice(1).map((l) => l.split(",")[0]);\nconst hot = new Set();\nfor (const priority of ["urgent", "high"]) for (const status of ["open", "pending"]) {\n  const r = await fetchAll("tickets_search", { priority, status });\n  r.tickets.forEach((t) => hot.add(t.customer_id));\n}\nreturn vip.filter((id) => hot.has(id)).join(", ");`,
  }),
  defineTask({
    id: "transform-vip-free-tier",
    title: "VIP list customers on the free tier",
    category: "transform",
    chain: "short",
    payload: "small",
    requiredTools: ["files_read", "crm_search_customers"],
    params: (w) => {
      const vip = w.files["/exports/vip_list.csv"]!.trim().split("\n").slice(1).map((l) => l.split(",")[0]!);
      return { ids: vip.filter((id) => customer(w, id).tier === "free") };
    },
    prompt: () => `Which customers on /exports/vip_list.csv are on the free tier? Reply with their customer IDs.`,
    verify: ({ params, answer }) => checkIdSet(answer, params.ids, CUSTOMER_ID),
    oracle: () =>
      `const f = await codemode.files_read({ path: "/exports/vip_list.csv" });\nconst vip = f.content.trim().split("\\n").slice(1).map((l) => l.split(",")[0]);\nconst r = await fetchAll("crm_search_customers", { tier: "free" });\nconst free = new Set(r.customers.map((c) => c.id));\nreturn vip.filter((id) => free.has(id)).join(", ");`,
  }),
  defineTask({
    id: "transform-next-meeting",
    title: "Next meeting with a customer",
    category: "transform",
    chain: "short",
    payload: "small",
    requiredTools: ["crm_get_customer", "calendar_list_events"],
    params: (w) => {
      const future = w.events.filter((e) => e.start > w.now).sort((a, b) => a.start.localeCompare(b.start));
      const c = w.customers.find((x) => future.some((e) => e.attendees.includes(x.email)))!;
      return { id: c.id, company: c.company, start: future.find((e) => e.attendees.includes(c.email))!.start };
    },
    prompt: (p) => `When is the next scheduled meeting with ${p.company} (customer ${p.id})? Reply with the start time in ISO 8601 (UTC).`,
    verify: ({ params, answer }) => checkDateTime(answer, params.start),
    oracle: (p) =>
      `const c = await codemode.crm_get_customer({ customer_id: ${j(p.id)} });\nconst r = await codemode.calendar_list_events({ from: "2026-03-15T09:00:00Z", attendee: c.email });\nreturn r.events[0].start;`,
  }),
  defineTask({
    id: "transform-customer-ticket-summary",
    title: "Ticket counts for one customer",
    category: "transform",
    chain: "short",
    payload: "small",
    requiredTools: ["tickets_search"],
    params: (w) => {
      const id = "C008";
      const mine = w.tickets.filter((t) => t.customer_id === id);
      return { id, total: mine.length, active: mine.filter(isActive).length };
    },
    prompt: (p) => `For customer ${p.id}, how many support tickets have they opened in total, and how many are not closed? Answer in the form total=<n>, active=<m>.`,
    verify: ({ params, answer }) => {
      const total = keyedNumber(answer, "total");
      const active = keyedNumber(answer, "active");
      return all(
        total === params.total ? ok("total matches") : fail(`total: expected ${params.total}, got ${total}`),
        active === params.active ? ok("active matches") : fail(`active: expected ${params.active}, got ${active}`),
      );
    },
    oracle: (p) =>
      `const r = await codemode.tickets_search({ customer_id: ${j(p.id)}, limit: 500 });\nreturn "total=" + r.total + ", active=" + r.tickets.filter((t) => t.status !== "closed").length;`,
  }),
  defineTask({
    id: "transform-escalate-by-email",
    title: "Escalate a customer's latest ticket and notify their manager",
    category: "transform",
    chain: "long",
    payload: "small",
    requiredTools: ["crm_search_customers", "tickets_search", "tickets_update", "directory_list_staff", "email_send"],
    pilot: true,
    params: (w) => {
      const c = w.customers.find((x) => w.tickets.filter((t) => t.customer_id === x.id && isActive(t)).length >= 2 && !x.email.endsWith("example.org"))!;
      const latest = w.tickets.filter((t) => t.customer_id === c.id && isActive(t)).sort((a, b) => b.created_at.localeCompare(a.created_at))[0]!;
      return { email: c.email, ticketId: latest.id, managerEmail: staffEmail(w, c.account_manager) };
    },
    prompt: (p) =>
      `The customer with the email address ${p.email} reported a critical problem. Find their most recently created ticket that is not closed, set its priority to urgent, assign it to Ruth Adeyemi, and email their account manager the ticket ID.`,
    verify: (ctx) => {
      const { params, final } = ctx;
      const t = ticket(final, params.ticketId);
      const mail = final.outbox.find((m) => m.to.map((x) => x.toLowerCase()).includes(params.managerEmail) && (m.subject + m.body).includes(params.ticketId));
      return all(
        t.priority === "urgent" ? ok("priority urgent") : fail(`priority is ${t.priority}`),
        t.assignee === "Ruth Adeyemi" ? ok("assigned") : fail(`assignee is ${t.assignee}`),
        mail ? ok("manager emailed") : fail("no email to the account manager containing the ticket ID"),
        onlyChanged(ctx, new Set([params.ticketId])),
      );
    },
    oracle: (p) =>
      `const c = (await codemode.crm_search_customers({ query: ${j(p.email)} })).customers[0];\nconst r = await fetchAll("tickets_search", { customer_id: c.id });\nconst t = r.tickets.filter((x) => x.status !== "closed").sort((a, b) => b.created_at.localeCompare(a.created_at))[0];\nawait codemode.tickets_update({ ticket_id: t.id, priority: "urgent", assignee: "Ruth Adeyemi" });\nconst staff = await codemode.directory_list_staff({});\nconst m = staff.staff.find((s) => s.name === c.account_manager);\nawait codemode.email_send({ to: [m.email], subject: "Escalated ticket " + t.id, body: "Ticket " + t.id + " for " + c.company + " has been escalated to urgent." });\nreturn "Escalated " + t.id;`,
  }),

  // ===================================================== write
  defineTask({
    id: "write-create-ticket",
    title: "Create a ticket",
    category: "write",
    chain: "single",
    payload: "small",
    requiredTools: ["tickets_create"],
    pilot: true,
    params: () => ({ id: "C033" }),
    prompt: (p) => `Create a high-priority ticket for customer ${p.id} with the subject "Login failure" and the body "Customer cannot log in since this morning."`,
    verify: (ctx) => {
      const created = newTickets(ctx);
      if (created.length !== 1) return fail(`expected 1 new ticket, found ${created.length}`, created.length > 1 ? 0.5 : 0);
      const t = created[0]!;
      return all(
        t.customer_id === ctx.params.id ? ok("customer") : fail(`customer is ${t.customer_id}`),
        norm(t.subject) === "login failure" ? ok("subject") : fail(`subject is "${t.subject}"`),
        t.priority === "high" ? ok("priority") : fail(`priority is ${t.priority}`),
        /cannot log in/i.test(t.body) ? ok("body") : fail("body does not match"),
      );
    },
    oracle: (p) =>
      `const t = await codemode.tickets_create({ customer_id: ${j(p.id)}, subject: "Login failure", body: "Customer cannot log in since this morning.", priority: "high" });\nreturn "Created " + t.id;`,
  }),
  defineTask({
    id: "write-close-with-comment",
    title: "Close a ticket with a comment",
    category: "write",
    chain: "short",
    payload: "small",
    requiredTools: ["tickets_update", "tickets_add_comment"],
    params: (w) => ({ id: w.tickets.find((t) => t.id >= "T0045" && isActive(t))!.id }),
    prompt: (p) => `Close ticket ${p.id} and add the comment "Resolved via phone call."`,
    verify: (ctx) => {
      const t = ticket(ctx.final, ctx.params.id);
      const last = t.comments[t.comments.length - 1];
      return all(
        t.status === "closed" ? ok("closed") : fail(`status is ${t.status}`),
        last && /resolved via phone call/i.test(last.body) ? ok("comment") : fail("comment missing"),
        onlyChanged(ctx, new Set([ctx.params.id])),
      );
    },
    oracle: (p) =>
      `await codemode.tickets_update({ ticket_id: ${j(p.id)}, status: "closed" });\nawait codemode.tickets_add_comment({ ticket_id: ${j(p.id)}, body: "Resolved via phone call." });\nreturn "Done";`,
  }),
  defineTask({
    id: "write-mark-invoice-paid",
    title: "Mark an invoice as paid",
    category: "write",
    chain: "single",
    payload: "small",
    requiredTools: ["crm_update_invoice"],
    params: (w) => ({ id: overdueInvoices(w)[0]!.id }),
    prompt: (p) => `Mark invoice ${p.id} as paid.`,
    verify: (ctx) => {
      const changed = ctx.initial.invoices.filter((i, k) => i.status !== ctx.final.invoices[k]!.status).map((i) => i.id);
      return compareSets(new Set(changed), new Set([ctx.params.id]), "changed invoices").pass &&
        ctx.final.invoices.find((i) => i.id === ctx.params.id)!.status === "paid"
        ? ok("invoice paid")
        : fail(`changed invoices: [${changed.join(", ")}]`);
    },
    oracle: (p) => `await codemode.crm_update_invoice({ invoice_id: ${j(p.id)}, status: "paid" });\nreturn "Done";`,
  }),
  defineTask({
    id: "write-upgrade-customer",
    title: "Upgrade a customer and change account manager",
    category: "write",
    chain: "single",
    payload: "small",
    requiredTools: ["crm_update_customer"],
    pilot: true,
    params: (w) => ({ id: w.customers.find((c) => c.tier === "free" && c.account_manager !== "Ananya Rao")!.id }),
    prompt: (p) => `Upgrade customer ${p.id} to the enterprise tier and make Ananya Rao their account manager.`,
    verify: ({ params, initial, final }) => {
      const c = customer(final, params.id);
      const others = final.customers.filter((x, k) => x.id !== params.id && (x.tier !== initial.customers[k]!.tier || x.account_manager !== initial.customers[k]!.account_manager));
      return all(
        c.tier === "enterprise" ? ok("tier") : fail(`tier is ${c.tier}`),
        c.account_manager === "Ananya Rao" ? ok("manager") : fail(`manager is ${c.account_manager}`),
        others.length === 0 ? ok("no other customers changed") : fail(`other customers changed: ${others.map((x) => x.id).join(", ")}`),
      );
    },
    oracle: (p) => `await codemode.crm_update_customer({ customer_id: ${j(p.id)}, tier: "enterprise", account_manager: "Ananya Rao" });\nreturn "Done";`,
  }),
  defineTask({
    id: "write-apply-escalation-policy",
    title: "Apply the escalation policy document",
    category: "write",
    chain: "loop",
    payload: "large",
    requiredTools: ["files_read", "crm_search_customers", "tickets_search", "tickets_update"],
    pilot: true,
    params: (w) => {
      const ent = new Set(w.customers.filter((c) => c.tier === "enterprise").map((c) => c.id));
      return { ids: w.tickets.filter((t) => isActive(t) && t.priority === "high" && ent.has(t.customer_id)).map((t) => t.id) };
    },
    prompt: () => `Apply the escalation policy in /policies/escalation.md to all tickets.`,
    verify: (ctx) => {
      const changed = changedTickets(ctx, ["priority"]);
      const escalated = new Set([...changed].filter((id) => ticket(ctx.final, id).priority === "urgent"));
      return all(compareSets(escalated, new Set(ctx.params.ids), "escalated tickets"), compareSets(changed, new Set(ctx.params.ids), "tickets with changed priority"));
    },
    oracle: () =>
      `const c = await fetchAll("crm_search_customers", { tier: "enterprise" });\nconst ent = new Set(c.customers.map((x) => x.id));\nconst lists = await Promise.all(["open", "pending"].map((status) => fetchAll("tickets_search", { status, priority: "high" })));\nconst targets = lists.flatMap((r) => r.tickets).filter((t) => ent.has(t.customer_id));\nawait Promise.all(targets.map((t) => codemode.tickets_update({ ticket_id: t.id, priority: "urgent" })));\nreturn "Escalated " + targets.length + " tickets";`,
  }),
  defineTask({
    id: "write-overdue-followup-tickets",
    title: "Create follow-up tickets for long-overdue invoices",
    category: "write",
    chain: "loop",
    payload: "large",
    requiredTools: ["crm_list_invoices", "tickets_create"],
    pilot: true,
    params: (w) => ({
      expected: overdueInvoices(w)
        .filter((i) => i.due_at < "2026-01-14")
        .map((i) => ({ invoice: i.id, customer: i.customer_id })),
    }),
    prompt: () =>
      `For every overdue invoice whose due date is before 2026-01-14, create a ticket for that invoice's customer with the subject "Payment overdue: <invoice ID>" (for example "Payment overdue: INV-0001"), priority high, and a short body of your choice.`,
    verify: (ctx) => {
      const created = newTickets(ctx);
      const want = new Set(ctx.params.expected.map((e: { invoice: string; customer: string }) => `${e.customer}|payment overdue: ${e.invoice.toLowerCase()}`));
      const got = new Set(created.filter((t) => t.priority === "high").map((t) => `${t.customer_id}|${norm(t.subject)}`));
      const v = compareSets(got, want, "follow-up tickets");
      return created.length > want.size && v.pass ? fail(`${created.length - want.size} extra tickets created`, 0.8) : v;
    },
    oracle: () =>
      `const r = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst due = r.invoices.filter((i) => i.due_at < "2026-01-14");\nawait Promise.all(due.map((i) => codemode.tickets_create({ customer_id: i.customer_id, subject: "Payment overdue: " + i.id, body: "Invoice " + i.id + " is overdue. Please follow up.", priority: "high" })));\nreturn "Created " + due.length + " tickets";`,
  }),
  defineTask({
    id: "write-assign-unassigned-urgent",
    title: "Assign all unassigned urgent tickets",
    category: "write",
    chain: "loop",
    payload: "large",
    requiredTools: ["tickets_search", "tickets_update"],
    params: (w) => ({ ids: w.tickets.filter((t) => t.priority === "urgent" && isActive(t) && t.assignee === null).map((t) => t.id) }),
    prompt: () => `Assign every unassigned urgent ticket that is not closed to Daniel Osei.`,
    verify: (ctx) => {
      const changed = changedTickets(ctx, ["assignee"]);
      const toDaniel = new Set([...changed].filter((id) => ticket(ctx.final, id).assignee === "Daniel Osei"));
      return all(compareSets(toDaniel, new Set(ctx.params.ids), "assigned tickets"), compareSets(changed, new Set(ctx.params.ids), "tickets with changed assignee"));
    },
    oracle: () =>
      `const lists = await Promise.all(["open", "pending"].map((status) => fetchAll("tickets_search", { priority: "urgent", status })));\nconst targets = lists.flatMap((r) => r.tickets).filter((t) => t.assignee === null);\nawait Promise.all(targets.map((t) => codemode.tickets_update({ ticket_id: t.id, assignee: "Daniel Osei" })));\nreturn "Assigned " + targets.length;`,
  }),
  defineTask({
    id: "write-tag-churn-risk",
    title: "Tag churn-risk tickets",
    category: "write",
    chain: "loop",
    payload: "large",
    requiredTools: ["crm_search_customers", "crm_list_invoices", "tickets_search", "tickets_update"],
    params: (w) => {
      const debtors = customersWithOverdue(w);
      const free = new Set(w.customers.filter((c) => c.tier === "free" && debtors.has(c.id)).map((c) => c.id));
      return { ids: w.tickets.filter((t) => isActive(t) && free.has(t.customer_id)).map((t) => t.id) };
    },
    prompt: () => `Add the tag "churn-risk" to every open or pending ticket that belongs to a free-tier customer with at least one overdue invoice.`,
    verify: (ctx) => {
      const tagged = new Set(ctx.final.tickets.filter((t) => t.tags.includes("churn-risk")).map((t) => t.id));
      return all(compareSets(tagged, new Set(ctx.params.ids), "tagged tickets"), onlyChanged(ctx, new Set(ctx.params.ids)));
    },
    oracle: () =>
      `const inv = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst debtors = new Set(inv.invoices.map((i) => i.customer_id));\nconst free = (await fetchAll("crm_search_customers", { tier: "free" })).customers.filter((c) => debtors.has(c.id));\nconst lists = await Promise.all(free.map((c) => fetchAll("tickets_search", { customer_id: c.id })));\nconst targets = lists.flatMap((r) => r.tickets).filter((t) => t.status !== "closed");\nawait Promise.all(targets.map((t) => codemode.tickets_update({ ticket_id: t.id, add_tags: ["churn-risk"] })));\nreturn "Tagged " + targets.length;`,
  }),
  defineTask({
    id: "write-schedule-renewal-call",
    title: "Schedule a renewal call",
    category: "write",
    chain: "short",
    payload: "small",
    requiredTools: ["crm_get_customer", "directory_list_staff", "calendar_create_event"],
    pilot: true,
    params: (w) => {
      const c = w.customers.find((x) => x.lifecycle_stage === "renewal")!;
      return { id: c.id, customerEmail: c.email, managerEmail: staffEmail(w, c.account_manager) };
    },
    prompt: (p) =>
      `Schedule a 30-minute meeting titled "Renewal call" on 2026-03-18 at 15:00 UTC with customer ${p.id} and their account manager. Invite both by email address.`,
    verify: ({ params, initial, final }) => {
      const created = final.events.filter((e) => !initial.events.some((x) => x.id === e.id));
      if (created.length !== 1) return fail(`expected 1 new event, found ${created.length}`);
      const e = created[0]!;
      const attendees = e.attendees.map((a) => a.toLowerCase());
      return all(
        norm(e.title) === "renewal call" ? ok("title") : fail(`title is "${e.title}"`),
        e.start === "2026-03-18T15:00:00.000Z" ? ok("start") : fail(`start is ${e.start}`),
        e.end === "2026-03-18T15:30:00.000Z" ? ok("end") : fail(`end is ${e.end}`),
        attendees.includes(params.customerEmail) && attendees.includes(params.managerEmail) ? ok("attendees") : fail(`attendees are ${e.attendees.join(", ")}`),
      );
    },
    oracle: (p) =>
      `const c = await codemode.crm_get_customer({ customer_id: ${j(p.id)} });\nconst s = await codemode.directory_list_staff({});\nconst m = s.staff.find((x) => x.name === c.account_manager);\nawait codemode.calendar_create_event({ title: "Renewal call", start: "2026-03-18T15:00:00Z", end: "2026-03-18T15:30:00Z", attendees: [c.email, m.email] });\nreturn "Scheduled";`,
  }),
  defineTask({
    id: "write-overdue-report-csv",
    title: "Export overdue invoices to a sorted CSV",
    category: "write",
    chain: "short",
    payload: "large",
    requiredTools: ["crm_list_invoices", "files_write"],
    pilot: true,
    params: (w) => ({
      rows: [...overdueInvoices(w)].sort((a, b) => b.amount - a.amount || a.id.localeCompare(b.id)).map((i) => [i.id, i.customer_id, i.amount] as [string, string, number]),
    }),
    prompt: () =>
      `Write a CSV file to /exports/overdue_report.csv with the header invoice_id,customer_id,amount and one row per overdue invoice, sorted by amount from highest to lowest.`,
    verify: ({ params, final }) => {
      const content = final.files["/exports/overdue_report.csv"];
      if (content === undefined) return fail("file not written");
      const lines = content.trim().split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
      if (norm(lines[0] ?? "").replace(/\s/g, "") !== "invoice_id,customer_id,amount") return fail(`unexpected header: ${lines[0]}`, 0.1);
      const rows = lines.slice(1).map((l) => l.split(",").map((x) => x.trim().replace(/^"|"$/g, "")));
      const want = params.rows as [string, string, number][];
      const setCheck = compareSets(new Set(rows.map((r) => `${r[0]}|${r[1]}|${Number(r[2]).toFixed(2)}`)), new Set(want.map((r) => `${r[0]}|${r[1]}|${r[2].toFixed(2)}`)), "rows");
      if (!setCheck.pass) return setCheck;
      const amounts = rows.map((r) => Number(r[2]));
      const sorted = amounts.every((a, k) => k === 0 || amounts[k - 1]! >= a);
      return sorted ? ok(`${rows.length} rows, sorted`) : fail("rows are not sorted by amount descending", 0.7);
    },
    oracle: () =>
      `const r = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst rows = r.invoices.sort((a, b) => b.amount - a.amount).map((i) => i.id + "," + i.customer_id + "," + i.amount.toFixed(2));\nawait codemode.files_write({ path: "/exports/overdue_report.csv", content: ["invoice_id,customer_id,amount", ...rows].join("\\n") + "\\n" });\nreturn "Wrote " + rows.length + " rows";`,
  }),
  defineTask({
    id: "write-reopen-closed-tickets",
    title: "Reopen a customer's closed tickets",
    category: "write",
    chain: "loop",
    payload: "small",
    requiredTools: ["tickets_search", "tickets_update"],
    params: (w) => {
      const c = w.customers.find((x) => w.tickets.filter((t) => t.customer_id === x.id && t.status === "closed").length >= 3)!;
      return { id: c.id, ids: w.tickets.filter((t) => t.customer_id === c.id && t.status === "closed").map((t) => t.id) };
    },
    prompt: (p) => `Reopen all closed tickets of customer ${p.id} by setting their status to open.`,
    verify: (ctx) => {
      const reopened = new Set(ctx.final.tickets.filter((t) => ctx.params.ids.includes(t.id) && t.status === "open").map((t) => t.id));
      return all(compareSets(reopened, new Set(ctx.params.ids), "reopened tickets"), onlyChanged(ctx, new Set(ctx.params.ids)));
    },
    oracle: (p) =>
      `const r = await codemode.tickets_search({ customer_id: ${j(p.id)}, status: "closed", limit: 500 });\nawait Promise.all(r.tickets.map((t) => codemode.tickets_update({ ticket_id: t.id, status: "open" })));\nreturn "Reopened " + r.tickets.length;`,
  }),
  defineTask({
    id: "write-comment-active-tickets",
    title: "Comment on every active ticket of a customer",
    category: "write",
    chain: "loop",
    payload: "small",
    requiredTools: ["tickets_search", "tickets_add_comment"],
    params: (w) => {
      const c = [...w.customers].reverse().find((x) => w.tickets.filter((t) => t.customer_id === x.id && isActive(t)).length >= 3)!;
      return { id: c.id, ids: w.tickets.filter((t) => t.customer_id === c.id && isActive(t)).map((t) => t.id) };
    },
    prompt: (p) => `Add the comment "Account manager notified." to every ticket of customer ${p.id} that is not closed.`,
    verify: (ctx) => {
      const commented = new Set(
        ctx.final.tickets
          .filter((t) => t.comments.slice(ticket(ctx.initial, t.id)?.comments.length ?? 0).some((c) => /account manager notified/i.test(c.body)))
          .map((t) => t.id),
      );
      return all(compareSets(commented, new Set(ctx.params.ids), "commented tickets"), onlyChanged(ctx, new Set(ctx.params.ids)));
    },
    oracle: (p) =>
      `const r = await codemode.tickets_search({ customer_id: ${j(p.id)}, limit: 500 });\nconst active = r.tickets.filter((t) => t.status !== "closed");\nawait Promise.all(active.map((t) => codemode.tickets_add_comment({ ticket_id: t.id, body: "Account manager notified." })));\nreturn "Commented on " + active.length;`,
  }),

  // ===================================================== privacy-sensitive
  defineTask({
    id: "privacy-overdue-reminders",
    title: "Email payment reminders to every customer with overdue invoices",
    category: "privacy",
    chain: "loop",
    payload: "large",
    requiredTools: ["crm_list_invoices", "crm_get_customer", "email_send"],
    pilot: true,
    params: (w) => {
      const byCustomer = new Map<string, string[]>();
      for (const i of overdueInvoices(w)) byCustomer.set(i.customer_id, [...(byCustomer.get(i.customer_id) ?? []), i.id]);
      return { expected: [...byCustomer.entries()].map(([id, invoices]) => ({ email: customer(w, id).email, invoices })) };
    },
    prompt: () =>
      `Send a payment reminder email to every customer that has at least one overdue invoice. Send exactly one email per customer to their email address, use the subject "Payment reminder", and list that customer's overdue invoice IDs in the body.`,
    verify: ({ params, final }) => {
      const expected = params.expected as { email: string; invoices: string[] }[];
      const mails = final.outbox.filter((m) => norm(m.subject) === "payment reminder");
      const recipients = mails.flatMap((m) => m.to.map((t) => t.toLowerCase()));
      const recipientCheck = compareSets(new Set(recipients), new Set(expected.map((e) => e.email.toLowerCase())), "recipients");
      const duplicates = recipients.length - new Set(recipients).size;
      const complete = expected.filter((e) => mails.some((m) => m.to.map((t) => t.toLowerCase()).includes(e.email.toLowerCase()) && e.invoices.every((id) => m.body.includes(id)))).length;
      return all(
        recipientCheck,
        duplicates === 0 ? ok("one email per customer") : fail(`${duplicates} duplicate emails`, 0.5),
        complete === expected.length ? ok("all bodies list the right invoices") : fail(`${expected.length - complete} emails missing invoice IDs`, complete / expected.length),
      );
    },
    oracle: () =>
      `const r = await fetchAll("crm_list_invoices", { status: "overdue" });\nconst by = {};\nfor (const i of r.invoices) (by[i.customer_id] = by[i.customer_id] || []).push(i.id);\nawait Promise.all(Object.entries(by).map(async ([id, inv]) => {\n  const c = await codemode.crm_get_customer({ customer_id: id });\n  await codemode.email_send({ to: [c.email], subject: "Payment reminder", body: "Dear " + c.name + ", the following invoices are overdue: " + inv.join(", ") + "." });\n}));\nreturn "Sent " + Object.keys(by).length + " reminders";`,
  }),
  defineTask({
    id: "privacy-count-email-domain",
    title: "Count customers on an email domain",
    category: "privacy",
    chain: "single",
    payload: "large",
    requiredTools: ["crm_search_customers"],
    params: (w) => ({ count: w.customers.filter((c) => c.email.endsWith("@example.org")).length }),
    prompt: () => `How many customers have an email address at the domain example.org?`,
    verify: ({ params, answer }) => checkNumber(answer, params.count, 0),
    oracle: () => `const r = await fetchAll("crm_search_customers", { query: "@example.org" });\nreturn String(r.customers.filter((c) => c.email.endsWith("@example.org")).length);`,
  }),
  defineTask({
    id: "privacy-export-phone-numbers",
    title: "Export phone numbers of customers in one country",
    category: "privacy",
    chain: "short",
    payload: "large",
    requiredTools: ["crm_search_customers", "files_write"],
    params: (w) => ({ phones: w.customers.filter((c) => c.country === "Canada").map((c) => c.phone) }),
    prompt: () => `Write the phone numbers of all customers based in Canada to /exports/canada_phones.txt, one number per line and nothing else.`,
    verify: ({ params, final }) => {
      const content = final.files["/exports/canada_phones.txt"];
      if (content === undefined) return fail("file not written");
      return compareSets(new Set(content.split(/\r?\n/).map((l) => l.trim()).filter(Boolean)), new Set(params.phones), "phone numbers");
    },
    oracle: () =>
      `const r = await fetchAll("crm_search_customers", { country: "Canada" });\nawait codemode.files_write({ path: "/exports/canada_phones.txt", content: r.customers.map((c) => c.phone).join("\\n") + "\\n" });\nreturn "Wrote " + r.customers.length + " numbers";`,
  }),
];

export function getTask(id: string): TaskDefinition<any> {
  const t = TASKS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown task: ${id}`);
  return t;
}

/** Resolve a task selector from a config: "all", "pilot", or explicit IDs. */
export function selectTasks(selector: "all" | "pilot" | string[]): TaskDefinition<any>[] {
  if (selector === "all") return TASKS;
  if (selector === "pilot") return TASKS.filter((t) => t.pilot);
  return selector.map(getTask);
}

