/**
 * Answer- and state-checking helpers. Verification is fully programmatic:
 * no model is used as a judge.
 */

export interface Verification {
  pass: boolean;
  /** Partial credit in [0, 1]. Equals 1 iff pass. */
  score: number;
  details: string;
}

export const ok = (details = "ok"): Verification => ({ pass: true, score: 1, details });
export const fail = (details: string, score = 0): Verification => ({ pass: false, score: Math.max(0, Math.min(score, 0.999)), details });

const ID_PATTERNS = [/\bC\d{3}\b/g, /\bT\d{4}\b/g, /\bINV-\d{4}\b/g, /\bEV\d{3}\b/g, /\d{4}-\d{2}-\d{2}(T[\d:.]+Z?)?/g];

/** Extract numeric values from free text, ignoring IDs and dates. Handles "1,234.56" and "$1234". */
export function numbersIn(text: string): number[] {
  let t = text;
  for (const p of ID_PATTERNS) t = t.replace(p, " ");
  return [...t.matchAll(/-?\d[\d,]*(?:\.\d+)?/g)]
    .map((m) => Number(m[0].replace(/,(?=\d{3}\b)/g, "").replace(/,/g, "")))
    .filter((n) => Number.isFinite(n));
}

export function checkNumber(answer: string, expected: number, tolerance = 0.01): Verification {
  const nums = numbersIn(answer);
  if (nums.some((n) => Math.abs(n - expected) <= tolerance)) return ok(`found ${expected}`);
  return fail(`expected ${expected}, found [${nums.join(", ")}]`);
}

export function idsIn(text: string, pattern: RegExp): Set<string> {
  return new Set([...text.matchAll(new RegExp(pattern.source, "g"))].map((m) => m[0]));
}

export function checkIdSet(answer: string, expected: Iterable<string>, pattern: RegExp): Verification {
  return compareSets(idsIn(answer, pattern), new Set(expected), "ids");
}

export function compareSets(found: Set<string>, expected: Set<string>, label = "items"): Verification {
  const missing = [...expected].filter((x) => !found.has(x));
  const extra = [...found].filter((x) => !expected.has(x));
  if (missing.length === 0 && extra.length === 0) return ok(`all ${expected.size} ${label} matched`);
  const union = new Set([...found, ...expected]).size || 1;
  const jaccard = (expected.size - missing.length) / union;
  return fail(`${label}: missing [${missing.slice(0, 10).join(", ")}]${missing.length > 10 ? "…" : ""}, unexpected [${extra.slice(0, 10).join(", ")}]${extra.length > 10 ? "…" : ""}`, jaccard);
}

export function checkContains(answer: string, needle: string): Verification {
  return answer.toLowerCase().includes(needle.toLowerCase()) ? ok(`contains "${needle}"`) : fail(`expected answer to contain "${needle}"`);
}

/** All needles must appear; partial credit by fraction found. */
export function checkContainsAll(answer: string, needles: string[]): Verification {
  const lower = answer.toLowerCase();
  const missing = needles.filter((n) => !lower.includes(n.toLowerCase()));
  if (missing.length === 0) return ok(`contains all ${needles.length} expected values`);
  return fail(`missing: ${missing.join(" | ")}`, (needles.length - missing.length) / needles.length);
}

/** Exactly the expected options (from a closed vocabulary) are mentioned. */
export function checkMentions(answer: string, vocabulary: string[], expected: string[]): Verification {
  const lower = answer.toLowerCase();
  const found = new Set(vocabulary.filter((v) => new RegExp(`\\b${escapeRe(v.toLowerCase())}\\b`).test(lower)));
  return compareSets(found, new Set(expected), "values");
}

/** At least one acceptable value is mentioned, and no unacceptable ones (handles ties). */
export function checkOneOf(answer: string, vocabulary: string[], acceptable: string[]): Verification {
  const lower = answer.toLowerCase();
  const found = vocabulary.filter((v) => lower.includes(v.toLowerCase()));
  const good = found.filter((f) => acceptable.includes(f));
  const bad = found.filter((f) => !acceptable.includes(f));
  if (good.length > 0 && bad.length === 0) return ok(`answered ${good[0]}`);
  return fail(`expected one of [${acceptable.join(", ")}], found [${found.join(", ")}]`);
}

/** Combine sub-checks: pass iff all pass, score is the mean. */
export function all(...checks: Verification[]): Verification {
  const score = checks.reduce((s, c) => s + c.score, 0) / checks.length;
  const failed = checks.filter((c) => !c.pass);
  return failed.length === 0 ? ok(checks.map((c) => c.details).join("; ")) : fail(failed.map((c) => c.details).join("; "), score);
}

/** Read `key=value` pairs from an answer such as "count=12, total=3400.50". */
export function keyedNumber(answer: string, key: string): number | undefined {
  const m = answer.match(new RegExp(`${escapeRe(key)}\\s*[=:]\\s*\\$?(-?[\\d,]+(?:\\.\\d+)?)`, "i"));
  return m ? Number(m[1]!.replace(/,/g, "")) : undefined;
}

export const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export const round = (n: number, digits: number) => Math.round(n * 10 ** digits) / 10 ** digits;
export const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
