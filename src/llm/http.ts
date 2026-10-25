import { Agent, fetch as undiciFetch } from "undici";

/**
 * Node's built-in fetch gives up if response headers take longer than 300 s.
 * Non-streaming chat requests to a local model on a small GPU can legitimately
 * take longer, so backends use this fetch instead. Run length is bounded by
 * the harness's own per-run time limit (via AbortSignal), not by the socket.
 */
const dispatcher = new Agent({ headersTimeout: 0, bodyTimeout: 0, connectTimeout: 10_000 });

export const httpFetch = ((input: string | URL, init?: Record<string, unknown>) =>
  undiciFetch(input, { ...(init ?? {}), dispatcher } as Parameters<typeof undiciFetch>[1])) as unknown as typeof globalThis.fetch;
