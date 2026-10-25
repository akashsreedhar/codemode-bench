import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type JsonSchema = Record<string, unknown>;

export interface ToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
}

export interface ToolCallOutcome {
  ok: boolean;
  /** Parsed result: structuredContent if present, else JSON-parsed text, else raw text. */
  data: unknown;
  /** Text form of the result, exactly as an MCP client would show it to a model. */
  text: string;
  /** Classifies failures for analysis. */
  errorKind?: "unknown_tool" | "invalid_args" | "tool_error";
}

/**
 * A set of connected MCP clients, addressed by tool name.
 *
 * In-process servers are connected over an in-memory transport so each
 * benchmark run gets an isolated, fast, deterministic set of servers. External
 * servers can be attached over stdio to inspect or drive real MCP servers.
 */
export class McpPool {
  private readonly clients = new Map<string, Client>();
  private readonly toolIndex = new Map<string, ToolInfo>();
  private readonly closers: (() => Promise<void>)[] = [];

  async addInMemory(name: string, server: McpServer): Promise<void> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: "codemode-bench", version: "1.0.0" });
    await client.connect(clientTransport);
    this.closers.push(async () => {
      await client.close();
      await server.close();
    });
    await this.register(name, client);
  }

  async addStdio(name: string, command: string, args: string[], env?: Record<string, string>): Promise<void> {
    const transport = new StdioClientTransport({ command, args, env: env ? { ...process.env, ...env } as Record<string, string> : undefined, stderr: "ignore" });
    const client = new Client({ name: "codemode-bench", version: "1.0.0" });
    await client.connect(transport);
    this.closers.push(() => client.close());
    await this.register(name, client);
  }

  private async register(serverName: string, client: Client) {
    this.clients.set(serverName, client);
    let cursor: string | undefined;
    do {
      const page = await client.listTools(cursor ? { cursor } : undefined);
      for (const t of page.tools) {
        if (this.toolIndex.has(t.name)) throw new Error(`Duplicate tool name across servers: ${t.name}`);
        this.toolIndex.set(t.name, {
          server: serverName,
          name: t.name,
          description: t.description ?? "",
          inputSchema: t.inputSchema as JsonSchema,
          outputSchema: t.outputSchema as JsonSchema | undefined,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
  }

  get tools(): ToolInfo[] {
    return [...this.toolIndex.values()];
  }

  get servers(): string[] {
    return [...this.clients.keys()];
  }

  hasTool(name: string): boolean {
    return this.toolIndex.has(name);
  }

  async callTool(name: string, args: unknown): Promise<ToolCallOutcome> {
    const info = this.toolIndex.get(name);
    if (!info) return { ok: false, data: null, text: `Error: unknown tool '${name}'`, errorKind: "unknown_tool" };
    if (args === null || typeof args !== "object" || Array.isArray(args)) {
      return { ok: false, data: null, text: "Error: tool arguments must be a JSON object", errorKind: "invalid_args" };
    }
    const client = this.clients.get(info.server)!;
    try {
      const res = await client.callTool({ name, arguments: args as Record<string, unknown> });
      const text = Array.isArray(res.content)
        ? res.content.map((c) => (c && typeof c === "object" && "text" in c ? String(c.text) : "")).join("\n")
        : "";
      if (res.isError) {
        const invalid = /invalid|validation|expected|required/i.test(text) && !/not found/i.test(text);
        return { ok: false, data: null, text: text.startsWith("Error") ? text : `Error: ${text}`, errorKind: invalid ? "invalid_args" : "tool_error" };
      }
      let data: unknown = res.structuredContent;
      if (data === undefined) {
        try {
          data = JSON.parse(text);
        } catch {
          data = text;
        }
      }
      return { ok: true, data, text };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const invalid = /invalid|validation|-32602/i.test(message);
      return { ok: false, data: null, text: `Error: ${message}`, errorKind: invalid ? "invalid_args" : "tool_error" };
    }
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.closers.map((c) => c()));
    this.clients.clear();
    this.toolIndex.clear();
  }
}
