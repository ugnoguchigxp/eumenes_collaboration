import { initial, host, proposal } from "../test/state.fixture.ts";
import { proposeStateUpdate, collaborationStateSchema } from "../src/index.ts";
import { resolve, join } from "node:path";
const baseline = (await import(
	join(resolve(import.meta.dir, ".."), ".work/evaluation-baseline/src/index.ts")
)) as { proposeStateUpdate: typeof proposeStateUpdate };
const rows = [];
for (const arm of ["baseline", "candidate"] as const)
	for (const count of [0, 999, 1000]) {
		const saved = initial();
		saved.facts = Array.from({ length: count }, (_, i) => ({
			...initial().facts[0]!,
			id: `f${i}`,
		}));
		const p = proposal();
		p.upserts[0]!.id = count ? "f0" : "new";
		p.upserts[0]!.supersedes = [];
		const durations: number[] = [];
		const memory = process.memoryUsage().rss;
		for (let i = 0; i < 30; i++) {
			const before = performance.now();
			const result = (
				arm === "baseline" ? baseline.proposeStateUpdate : proposeStateUpdate
			)(saved, p, host());
			durations.push(performance.now() - before);
			if (
				!result.ok ||
				!collaborationStateSchema.safeParse(result.state).success
			)
				throw new Error("benchmark_contract_failure");
		}
		durations.sort((a, b) => a - b);
		rows.push({
			arm,
			facts: count,
			iterations: 30,
			p50Ms: durations[14],
			p95Ms: durations[28],
			rssDeltaBytes: process.memoryUsage().rss - memory,
		});
	}
const result = {
	runtime: Bun.version,
	platform: process.platform,
	arch: process.arch,
	declaredLocalP95LimitMs: 200,
	passed: rows.every((r) => (r.p95Ms ?? Infinity) < 200),
	rows,
	limits:
		"In-process state workload only; live API timing and cost reported separately. RSS deltas are process-wide, not per-request memory attribution.",
};
await Bun.write(
	"reports/quality-2026-11-05/benchmark.json",
	JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result));
