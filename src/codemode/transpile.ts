import { transform } from "esbuild";

export class TranspileError extends Error {}

/**
 * Turn model-written TypeScript (which may use top-level `await` and
 * `return`) into a plain script that assigns the run's promise to
 * `globalThis.__result`.
 */
export async function transpileUserCode(code: string): Promise<string> {
  const source = stripFences(code);
  const wrapped = `globalThis.__result = (async () => {\n${source}\n})();\n`;
  try {
    const out = await transform(wrapped, { loader: "ts", target: "es2020", format: "esm", logLevel: "silent" });
    return out.code;
  } catch (err) {
    const e = err as { errors?: { text: string; location?: { line: number; column: number } | null }[] };
    const first = e.errors?.[0];
    if (first) {
      // Subtract the wrapper line so line numbers match the model's code.
      const where = first.location ? ` (line ${first.location.line - 1}, column ${first.location.column})` : "";
      throw new TranspileError(`SyntaxError: ${first.text}${where}`);
    }
    throw new TranspileError(`SyntaxError: ${String(err)}`);
  }
}

/** Models frequently wrap code in Markdown fences even inside tool arguments. */
export function stripFences(code: string): string {
  const m = code.match(/^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/);
  return m ? m[1]! : code;
}
