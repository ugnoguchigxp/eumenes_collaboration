/** Small, dependency-free statistics for the evaluation reports. */

/** Wilson score interval for k successes in n trials. An empty sample is uninformative: [0, 1]. */
export function wilson(
	k: number,
	n: number,
	z = 1.96,
): { low: number; high: number } {
	if (!Number.isInteger(k) || !Number.isInteger(n) || k < 0 || n < 0 || k > n)
		throw new Error("wilson_input_invalid");
	if (n === 0) return { low: 0, high: 1 };
	const p = k / n,
		z2 = z * z,
		denominator = 1 + z2 / n,
		center = (p + z2 / (2 * n)) / denominator,
		half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denominator;
	return {
		low: Math.max(0, center - half),
		high: Math.min(1, center + half),
	};
}

/** log of the binomial coefficient C(n, k), by summing logs (n stays small in these reports). */
const logChoose = (n: number, k: number) => {
	let total = 0;
	for (let i = 1; i <= k; i++) total += Math.log(n - k + i) - Math.log(i);
	return total;
};

/**
 * Exact two-sided McNemar test on the discordant pairs: b and c are the counts of the two kinds of disagreement.
 * Under H0 each discordant pair falls either way with probability 1/2.
 */
export function mcnemarExact(b: number, c: number): number {
	if (!Number.isInteger(b) || !Number.isInteger(c) || b < 0 || c < 0)
		throw new Error("mcnemar_input_invalid");
	const n = b + c;
	if (n === 0) return 1;
	const k = Math.min(b, c);
	let tail = 0;
	for (let i = 0; i <= k; i++) tail += Math.exp(logChoose(n, i) - n * Math.LN2);
	return Math.min(1, 2 * tail);
}

/**
 * Cohen's kappa for two raters over the same items. Returns NaN for no items. When chance agreement is total
 * (both raters constant and equal) the agreement is perfect and the result is 1.
 */
export function cohenKappa(pairs: ReadonlyArray<readonly [boolean, boolean]>) {
	const n = pairs.length;
	if (n === 0) return Number.NaN;
	let agree = 0,
		aTrue = 0,
		bTrue = 0;
	for (const [a, b] of pairs) {
		if (a === b) agree++;
		if (a) aTrue++;
		if (b) bTrue++;
	}
	const observed = agree / n,
		expected = (aTrue / n) * (bTrue / n) + (1 - aTrue / n) * (1 - bTrue / n);
	if (expected === 1) return observed === 1 ? 1 : 0;
	return (observed - expected) / (1 - expected);
}

/** Strict majority of pass flags: a tie, and an empty list, count as a failure. */
export function majority(passes: readonly boolean[]): boolean {
	return passes.filter(Boolean).length * 2 > passes.length;
}
