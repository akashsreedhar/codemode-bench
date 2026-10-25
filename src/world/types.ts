/**
 * The simulated organisation that every benchmark task operates on.
 *
 * A world is generated deterministically from a seed, mutated only through MCP
 * tool calls during a run, and inspected by task verifiers afterwards.
 */

export type Tier = "free" | "pro" | "enterprise";
export type InvoiceStatus = "paid" | "open" | "overdue";
export type TicketPriority = "low" | "normal" | "high" | "urgent";
export type TicketStatus = "open" | "pending" | "closed";

export interface Address {
  street: string;
  city: string;
  postal_code: string;
  country: string;
}

export interface Customer {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  tier: Tier;
  country: string;
  account_manager: string;
  created_at: string;
  last_activity_at: string;
  lifecycle_stage: "onboarding" | "active" | "at_risk" | "renewal";
  notes: string;
  address: Address;
}

export interface Invoice {
  id: string;
  customer_id: string;
  amount: number;
  currency: "USD";
  status: InvoiceStatus;
  issued_at: string;
  due_at: string;
  line_items: { description: string; quantity: number; unit_price: number }[];
}

export interface TicketComment {
  author: string;
  body: string;
  created_at: string;
}

export interface Ticket {
  id: string;
  customer_id: string;
  subject: string;
  body: string;
  priority: TicketPriority;
  status: TicketStatus;
  assignee: string | null;
  tags: string[];
  created_at: string;
  updated_at: string;
  comments: TicketComment[];
}

export interface StaffMember {
  name: string;
  email: string;
  role: "account_manager" | "support_agent" | "support_lead";
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  attendees: string[];
  location: string;
}

export interface Email {
  id: string;
  to: string[];
  subject: string;
  body: string;
  sent_at: string;
}

export interface World {
  /** Fixed "current time" of the simulation, so date-relative tasks are deterministic. */
  now: string;
  seed: number;
  customers: Customer[];
  invoices: Invoice[];
  tickets: Ticket[];
  staff: StaffMember[];
  events: CalendarEvent[];
  outbox: Email[];
  files: Record<string, string>;
  counters: { ticket: number; event: number; email: number };
}
