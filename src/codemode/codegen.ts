import type { JsonSchema, ToolInfo } from "../mcp/pool.js";

/**
 * Converts MCP tool definitions (JSON Schema) into a TypeScript API surface:
 * one input/output interface pair per tool plus a `declare const codemode`
 * object whose methods are documented with the tool descriptions.
 */

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0]!.toUpperCase() + w.slice(1))
    .join("");
}

function jsdoc(text: string | undefined, indent: string): string {
  if (!text) return "";
  const lines = text.trim().split(/\r?\n/).flatMap((l) => wrap(l, 76));
  if (lines.length === 1) return `${indent}/** ${escapeDoc(lines[0]!)} */\n`;
  return `${indent}/**\n${lines.map((l) => `${indent} * ${escapeDoc(l)}`).join("\n")}\n${indent} */\n`;
}

const escapeDoc = (s: string) => s.replace(/\*\//g, "*\\/");

function wrap(line: string, width: number): string[] {
  if (line.length <= width) return [line];
  const words = line.split(" ");
  const out: string[] = [];
  let cur = "";
  for (const w of words) {
    if (cur && (cur + " " + w).length > width) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

const propKey = (k: string) => (IDENT.test(k) ? k : JSON.stringify(k));

export function schemaToType(schema: JsonSchema | boolean | undefined, indent = ""): string {
  if (schema === undefined || schema === true) return "unknown";
  if (schema === false) return "never";
  const s = schema as Record<string, unknown>;

  if (Array.isArray(s.enum)) return s.enum.map((v) => JSON.stringify(v)).join(" | ");
  if ("const" in s) return JSON.stringify(s.const);
  for (const key of ["anyOf", "oneOf"] as const) {
    if (Array.isArray(s[key])) {
      const parts = [...new Set((s[key] as JsonSchema[]).map((x) => schemaToType(x, indent)))];
      return parts.length === 1 ? parts[0]! : parts.map((p) => (p.includes("\n") ? p : p)).join(" | ");
    }
  }
  if (Array.isArray(s.allOf)) return (s.allOf as JsonSchema[]).map((x) => schemaToType(x, indent)).join(" & ");

  const type = s.type;
  if (Array.isArray(type)) {
    return type.map((t) => schemaToType({ ...s, type: t }, indent)).join(" | ");
  }
  const nullable = s.nullable === true ? " | null" : "";
  switch (type) {
    case "string":
      return "string" + nullable;
    case "number":
    case "integer":
      return "number" + nullable;
    case "boolean":
      return "boolean" + nullable;
    case "null":
      return "null";
    case "array": {
      const item = schemaToType(s.items as JsonSchema | undefined, indent);
      return (/^[A-Za-z0-9_]+$/.test(item) ? `${item}[]` : `Array<${item}>`) + nullable;
    }
    case "object":
    case undefined: {
      const props = (s.properties ?? {}) as Record<string, JsonSchema>;
      const keys = Object.keys(props);
      const additional = s.additionalProperties;
      if (keys.length === 0) {
        if (additional && typeof additional === "object") return `Record<string, ${schemaToType(additional as JsonSchema, indent)}>${nullable}`;
        return type === "object" || additional === true ? `Record<string, unknown>${nullable}` : "unknown";
      }
      return objectBody(s, indent) + nullable;
    }
    default:
      return "unknown";
  }
}

function objectBody(s: Record<string, unknown>, indent: string): string {
  const props = (s.properties ?? {}) as Record<string, JsonSchema>;
  const required = new Set((s.required as string[] | undefined) ?? []);
  const inner = indent + "  ";
  let out = "{\n";
  for (const [k, v] of Object.entries(props)) {
    out += jsdoc((v as Record<string, unknown>).description as string | undefined, inner);
    out += `${inner}${propKey(k)}${required.has(k) ? "" : "?"}: ${schemaToType(v, inner)};\n`;
  }
  const additional = s.additionalProperties;
  if (additional && typeof additional === "object") out += `${inner}[key: string]: ${schemaToType(additional as JsonSchema, inner)};\n`;
  return out + indent + "}";
}

function declareNamed(name: string, schema: JsonSchema | undefined): string {
  const body = schemaToType(schema, "");
  if (body.startsWith("{")) return `interface ${name} ${body}\n`;
  return `type ${name} = ${body};\n`;
}

export interface CodegenOptions {
  /** Name of the global object the sandbox exposes. */
  globalName?: string;
  /** Include a header comment. */
  header?: boolean;
}

/** Generate the TypeScript declarations for a set of tools. */
export function generateDeclarations(tools: readonly ToolInfo[], opts: CodegenOptions = {}): string {
  const globalName = opts.globalName ?? "codemode";
  const sorted = [...tools].sort((a, b) => a.server.localeCompare(b.server) || a.name.localeCompare(b.name));
  let types = "";
  let members = "";
  let currentServer = "";
  for (const t of sorted) {
    const base = pascalCase(t.name);
    types += declareNamed(`${base}Input`, t.inputSchema);
    types += t.outputSchema ? declareNamed(`${base}Output`, t.outputSchema) : `type ${base}Output = unknown;\n`;
    types += "\n";
    if (t.server !== currentServer) {
      currentServer = t.server;
      members += `  // ---- ${t.server} ----\n`;
    }
    members += jsdoc(t.description, "  ");
    members += `  ${propKey(t.name)}: (input: ${base}Input) => Promise<${base}Output>;\n`;
  }
  const header = opts.header === false ? "" : "// Auto-generated from MCP tool schemas. Each method calls the MCP tool of the same name.\n\n";
  return `${header}${types}declare const ${globalName}: {\n${members}};\n`;
}

/** One-line summaries per server, used for progressive API discovery. */
export function summariseServers(tools: readonly ToolInfo[]): { server: string; tools: { name: string; summary: string }[] }[] {
  const byServer = new Map<string, { name: string; summary: string }[]>();
  for (const t of tools) {
    const summary = (t.description.split(/(?<=\.)\s/)[0] ?? "").trim();
    byServer.set(t.server, [...(byServer.get(t.server) ?? []), { name: t.name, summary }]);
  }
  return [...byServer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([server, list]) => ({ server, tools: list.sort((a, b) => a.name.localeCompare(b.name)) }));
}

/** Rough token estimate (≈4 characters per token) used only for reporting sizes of static artefacts. */
export const estimateTokens = (text: string) => Math.ceil(text.length / 4);
