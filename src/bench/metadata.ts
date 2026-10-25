import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import os from "node:os";
import { TASKS } from "../tasks/suite.js";
import { generateWorld } from "../world/generate.js";

export interface HardwareInfo {
  platform: string;
  release: string;
  arch: string;
  cpu: string;
  cpuCores: number;
  ramGb: number;
  gpus: string[];
  node: string;
}

export interface GitInfo {
  commit: string | null;
  dirty: boolean | null;
}

function tryExec(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", timeout: 8_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

function detectGpus(): string[] {
  const nvidia = tryExec("nvidia-smi", ["--query-gpu=name,memory.total", "--format=csv,noheader"]);
  if (nvidia) return nvidia.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (process.platform === "win32") {
    const ps = tryExec("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_VideoController | ForEach-Object { $_.Name }"]);
    if (ps) return ps.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  }
  if (process.platform === "darwin") {
    const sp = tryExec("system_profiler", ["SPDisplaysDataType"]);
    const names = sp?.match(/Chipset Model: (.+)/g)?.map((l) => l.replace("Chipset Model: ", "").trim());
    if (names?.length) return names;
  }
  return [];
}

let hardwareCache: HardwareInfo | undefined;
export function hardwareInfo(): HardwareInfo {
  hardwareCache ??= {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpu: os.cpus()[0]?.model.trim() ?? "unknown",
    cpuCores: os.cpus().length,
    ramGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    gpus: detectGpus(),
    node: process.version,
  };
  return hardwareCache;
}

export function gitInfo(): GitInfo {
  const commit = tryExec("git", ["rev-parse", "HEAD"]);
  const status = commit ? tryExec("git", ["status", "--porcelain", "--untracked-files=no"]) : null;
  return { commit, dirty: status === null ? null : status.length > 0 };
}

export function harnessVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string };
  return pkg.version;
}

/**
 * Fingerprint of the task suite for a given world seed: prompts, expected
 * parameters, tool requirements and reference solutions. Results
 * with different fingerprints are not comparable.
 */
export function taskSetHash(worldSeed: number): string {
  const world = generateWorld(worldSeed);
  const h = createHash("sha256");
  for (const t of TASKS) {
    const params = t.params(world);
    h.update(JSON.stringify([t.id, t.prompt(params), params, t.requiredTools, t.oracle(params)]));
  }
  return h.digest("hex").slice(0, 16);
}
