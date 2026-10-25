/** Small, dependency-free statistics helpers. */

/** Wilson score interval for a binomial proportion. */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n === 0) return [0, 0];
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/**
 * Exact two-sided McNemar test on discordant pairs.
 * b = pairs where only the first condition succeeded, c = only the second.
 */
export function mcnemarExact(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  const k = Math.min(b, c);
  // P(X <= k) for X ~ Binomial(n, 0.5), computed in log space for stability.
  let logCoef = 0; // log C(n, 0)
  let cdf = 0;
  for (let i = 0; i <= k; i++) {
    if (i > 0) logCoef += Math.log(n - i + 1) - Math.log(i);
    cdf += Math.exp(logCoef - n * Math.LN2);
  }
  return Math.min(1, 2 * cdf);
}

export const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const arr = m.get(k);
    if (arr) arr.push(it);
    else m.set(k, [it]);
  }
  return m;
}
