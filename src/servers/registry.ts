import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Wraps McpServer so that a run can expose only a subset of a server's tools
 * (needed for the tool-count sweep), while keeping registration code readable.
 */
export class FilteredServer {
  readonly server: McpServer;
  readonly registered: string[] = [];

  constructor(
    name: string,
    private readonly allowed?: ReadonlySet<string>,
  ) {
    this.server = new McpServer({ name, version: "1.0.0" });
  }

  /** Same signature as McpServer.registerTool; tools outside the allow-list are skipped. */
  readonly tool = ((name: string, config: unknown, cb: unknown) => {
    if (this.allowed && !this.allowed.has(name)) return undefined;
    this.registered.push(name);
    return (this.server.registerTool as (n: string, c: unknown, f: unknown) => unknown).call(this.server, name, config, cb);
  }) as McpServer["registerTool"];
}

export interface ServerFactoryResult {
  name: string;
  server: McpServer;
  tools: string[];
}
