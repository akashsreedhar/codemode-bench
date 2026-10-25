import { z } from "zod";
import type { World } from "../world/types.js";
import { FilteredServer, type ServerFactoryResult } from "./registry.js";
import { ToolInputError, jsonResult } from "./schemas.js";

export const FILE_TOOLS = ["files_list", "files_read", "files_write", "files_search"] as const;

const normalise = (p: string) => {
  const parts = p.replace(/\\/g, "/").split("/").filter((x) => x && x !== ".");
  if (parts.includes("..")) throw new ToolInputError("Paths may not contain '..'");
  return "/" + parts.join("/");
};

export function createFilesServer(world: World, allowed?: ReadonlySet<string>): ServerFactoryResult {
  const s = new FilteredServer("files", allowed);

  s.tool(
    "files_list",
    {
      description: "List files under a directory of the shared drive (recursive). Use '/' for the root.",
      inputSchema: { dir: z.string().describe("Directory path, e.g. '/exports'") },
      outputSchema: { entries: z.array(z.object({ path: z.string(), size: z.number() })) },
    },
    async ({ dir }) => {
      const base = normalise(dir);
      const prefix = base === "/" ? "/" : base + "/";
      const entries = Object.keys(world.files)
        .filter((p) => p.startsWith(prefix))
        .sort()
        .map((p) => ({ path: p, size: world.files[p]!.length }));
      return jsonResult({ entries });
    },
  );

  s.tool(
    "files_read",
    {
      description: "Read the full text content of a file.",
      inputSchema: { path: z.string() },
      outputSchema: { path: z.string(), content: z.string() },
    },
    async ({ path }) => {
      const p = normalise(path);
      const content = world.files[p];
      if (content === undefined) throw new ToolInputError(`File not found: ${p}`);
      return jsonResult({ path: p, content });
    },
  );

  s.tool(
    "files_write",
    {
      description: "Create or overwrite a text file. Parent directories are created implicitly.",
      inputSchema: { path: z.string(), content: z.string() },
      outputSchema: { path: z.string(), size: z.number() },
    },
    async ({ path, content }) => {
      const p = normalise(path);
      world.files[p] = content;
      return jsonResult({ path: p, size: content.length });
    },
  );

  s.tool(
    "files_search",
    {
      description: "Full-text search across all files (case-insensitive). Returns matching lines with their file path and line number.",
      inputSchema: { query: z.string() },
      outputSchema: { matches: z.array(z.object({ path: z.string(), line: z.number(), text: z.string() })) },
    },
    async ({ query }) => {
      const q = query.toLowerCase();
      const matches: { path: string; line: number; text: string }[] = [];
      for (const [path, content] of Object.entries(world.files).sort(([a], [b]) => a.localeCompare(b))) {
        content.split("\n").forEach((text, i) => {
          if (text.toLowerCase().includes(q)) matches.push({ path, line: i + 1, text });
        });
      }
      return jsonResult({ matches });
    },
  );

  return { name: "files", server: s.server, tools: s.registered };
}
