import { describe, expect, it } from "vitest";
import { mcnemarExact, median, wilson } from "../src/report/stats.js";
import { checkIdSet, checkNumber, checkOneOf, keyedNumber, numbersIn } from "../src/tasks/verify.js";

describe("answer verification helpers", () => {
  it("extracts numbers while ignoring IDs and dates", () => {
    expect(numbersIn("Customer C017 owes $12,345.67 as of 2026-03-15 on INV-0042")).toEqual([12345.67]);
    expect(numbersIn("count=56, total=77980.83")).toEqual([56, 77980.83]);
  });

  it("checks numbers with a tolerance", () => {
    expect(checkNumber("The total is 101,049.94 USD", 101049.94, 0.011).pass).toBe(true);
    expect(checkNumber("The total is 101,049.00 USD", 101049.94, 0.011).pass).toBe(false);
  });

  it("requires exact ID sets and gives partial credit", () => {
    expect(checkIdSet("C074 and C099", ["C074", "C099"], /\bC\d{3}\b/).pass).toBe(true);
    const partial = checkIdSet("C074, C010", ["C074", "C099"], /\bC\d{3}\b/);
    expect(partial.pass).toBe(false);
    expect(partial.score).toBeCloseTo(1 / 3);
  });

  it("handles ties and rejects hedged answers", () => {
    expect(checkOneOf("Marcus Webb", ["Marcus Webb", "Tom Becker"], ["Marcus Webb"]).pass).toBe(true);
    expect(checkOneOf("Marcus Webb or Tom Becker", ["Marcus Webb", "Tom Becker"], ["Marcus Webb"]).pass).toBe(false);
  });

  it("reads keyed numbers", () => {
    expect(keyedNumber("count=56, total=77,980.83", "total")).toBe(77980.83);
    expect(keyedNumber("Total: 3", "total")).toBe(3);
    expect(keyedNumber("nothing", "total")).toBeUndefined();
  });
});

describe("statistics", () => {
  it("computes Wilson intervals", () => {
    const [lo, hi] = wilson(8, 10);
    expect(lo).toBeCloseTo(0.4902, 3);
    expect(hi).toBeCloseTo(0.9433, 3);
    expect(wilson(0, 0)).toEqual([0, 0]);
  });

  it("computes exact McNemar p-values", () => {
    expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 6);
    expect(mcnemarExact(3, 3)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 9)).toBeCloseTo(0.021484375, 6);
  });

  it("computes medians", () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
  });
});
