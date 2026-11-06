import { describe, expect, test } from "bun:test";
import { cohenKappa, majority, mcnemarExact, wilson } from "../eval/stats.ts";

describe("wilson", () => {
	test("27/30 gives the known 95% interval", () => {
		const { low, high } = wilson(27, 30);
		expect(low).toBeCloseTo(0.744, 3);
		expect(high).toBeCloseTo(0.965, 3);
	});
	test("edges stay inside [0, 1] and an empty sample is uninformative", () => {
		expect(wilson(0, 10).low).toBe(0);
		expect(wilson(10, 10).high).toBe(1);
		expect(wilson(0, 0)).toEqual({ low: 0, high: 1 });
		expect(() => wilson(5, 3)).toThrow();
	});
});

describe("mcnemarExact", () => {
	test("one-sided extreme gives the two-sided exact p", () => {
		expect(mcnemarExact(0, 6)).toBeCloseTo(0.03125, 6);
		expect(mcnemarExact(6, 0)).toBeCloseTo(0.03125, 6);
		expect(mcnemarExact(1, 5)).toBeCloseTo(0.21875, 6);
	});
	test("equal discordant counts, or none, give p = 1", () => {
		expect(mcnemarExact(3, 3)).toBe(1);
		expect(mcnemarExact(0, 0)).toBe(1);
	});
});

describe("cohenKappa", () => {
	test("perfect agreement is 1", () => {
		expect(
			cohenKappa([
				[true, true],
				[false, false],
				[true, true],
				[false, false],
			]),
		).toBe(1);
	});
	test("agreement at the chance level is about 0", () => {
		expect(
			cohenKappa([
				[true, true],
				[true, false],
				[false, true],
				[false, false],
			]),
		).toBeCloseTo(0, 10);
	});
	test("systematic disagreement is negative; no items is NaN", () => {
		expect(
			cohenKappa([
				[true, false],
				[false, true],
			]),
		).toBe(-1);
		expect(cohenKappa([])).toBeNaN();
	});
});

describe("majority", () => {
	test("strict majority passes; a tie and an empty list fail", () => {
		expect(majority([true, true, false])).toBe(true);
		expect(majority([true, false])).toBe(false);
		expect(majority([])).toBe(false);
		expect(majority([false, false, true])).toBe(false);
	});
});
