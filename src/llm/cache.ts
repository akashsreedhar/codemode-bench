import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ChatResponse } from "./types.js";

/**
 * Content-addressed response cache. Re-running an experiment (for example
 * after a crash, or to regenerate reports) replays identical requests from
 * disk instead of calling the model again.
 */
export class ResponseCache {
  constructor(private readonly dir: string) {}

  static key(parts: unknown): string {
    return createHash("sha256").update(stableStringify(parts)).digest("hex");
  }

  private path(key: string) {
    return join(this.dir, key.slice(0, 2), `${key}.json`);
  }

  async get(key: string): Promise<ChatResponse | undefined> {
    try {
      const raw = await readFile(this.path(key), "utf8");
      return { ...(JSON.parse(raw) as ChatResponse), cached: true };
    } catch {
      return undefined;
    }
  }

  async set(key: string, value: ChatResponse): Promise<void> {
    const p = this.path(key);
    await mkdir(join(this.dir, key.slice(0, 2)), { recursive: true });
    await writeFile(p, JSON.stringify({ ...value, cached: false }));
  }
}

/** JSON.stringify with sorted object keys, so equal requests hash equally. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, (v as Record<string, unknown>)[k]]));
    }
    return v;
  });
}
