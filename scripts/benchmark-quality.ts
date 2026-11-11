import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { initial, host, proposal } from "../test/state.fixture.ts";
import { proposeStateUpdate } from "../src/index.ts";
import { childEnv } from "./child-env.ts";

const root = resolve(import.meta.dir, "..");
const baselineCommit = "b03426226ef5ef6ead47c216a309bb48c2a420df";
await mkdir(join(root, ".work"), { recursive: true });
const temp = await mkdtemp(join(root, ".work/quality-benchmark-"));
const rows: Array<Record<string, unknown>> = [];
try {
	const archive = Bun.spawnSync(
		["git", "archive", baselineCommit, "src", ".s11tnext"],
		{ cwd: root, env: childEnv(process.env) },
	);
	if (archive.exitCode) throw new Error("benchmark_baseline_absent");
	const extracted = Bun.spawnSync(["tar", "-xf", "-", "-C", temp], {
		stdin: archive.stdout,
		env: childEnv(process.env),
	});
	if (extracted.exitCode) throw new Error("benchmark_baseline_extract_failed");
	const baseline = (await import(join(temp, "src/index.ts"))) as {
		proposeStateUpdate: typeof proposeStateUpdate;
	};
	for (const arm of ["baseline", "candidate"] as const)
		for (const shape of [
			"ordinary",
			"capacity",
			"chain",
			"dense",
			"byte-limit",
		] as const) {
			const count =
				shape === "ordinary" ? 20 : shape === "byte-limit" ? 1 : 1000;
			const state = initial();
			state.facts = Array.from({ length: count }, (_, i) => ({
				...state.facts[0]!,
				id: `f${i}`,
				supersedes:
					shape === "chain" && i
						? [`f${i - 1}`]
						: shape === "dense"
							? Array.from(
									{ length: Math.min(i, 64) },
									(_, j) => `f${i - j - 1}`,
								)
							: [],
			}));
			const p = proposal();
			p.upserts = [{ ...p.upserts[0]!, id: "f0", supersedes: [] }];
			if (shape === "byte-limit") {
				state.facts[0]!.value = "x".repeat(2 * 1024 * 1024 - 4096);
				p.upserts[0]!.value = state.facts[0]!.value;
			}
			const samples: number[] = [];
			for (let i = 0; i < 35; i++) {
				const started = performance.now();
				const result = (
					arm === "baseline" ? baseline.proposeStateUpdate : proposeStateUpdate
				)(state, p, host());
				const ms = performance.now() - started;
				if (!result.ok)
					throw new Error(
						`benchmark_contract_failure:${arm}:${shape}:${result.reason}`,
					);
				if (i >= 5) samples.push(ms);
			}
			samples.sort((a, b) => a - b);
			rows.push({
				arm,
				shape,
				facts: count,
				stateBytes: Buffer.byteLength(JSON.stringify(state)),
				iterations: samples.length,
				p50Ms: samples[14],
				p95Ms: samples[28],
				p99Ms: samples[29],
			});
		}
} finally {
	await rm(temp, { recursive: true, force: true });
}
const report = {
	baselineCommit,
	runtime: Bun.version,
	platform: process.platform,
	arch: process.arch,
	localP95LimitMs: 200,
	passed: rows.every((r) => (r.p95Ms as number) < 200),
	rows,
	limits:
		"Same-process structural validation. Database contention has separate tests; production inference latency and cost require live acceptance.",
};
await mkdir(join(root, "reports/quality-2026-11-07"), { recursive: true });
await writeFile(
	join(root, "reports/quality-2026-11-07/benchmark.json"),
	JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
