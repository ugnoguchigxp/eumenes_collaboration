import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { childEnv } from "./child-env.ts";

const root = resolve(import.meta.dir, "..");
await mkdir(join(root, ".work"), { recursive: true });
const temp = await mkdtemp(join(root, ".work/approval-guards-"));
const cases = [
	["epoch", "approval.epoch !== host.epoch ||", "false ||"],
	[
		"user-source",
		'source?.kind !== "user" || !source.active',
		"!source?.active",
	],
	["reviewed-content", "!equivalent(approval.fact, fact)", "false"],
	[
		"source-revocation",
		"!fact.sourceRefs.every((sourceRef) => refs.get(sourceRef)?.active)",
		"false",
	],
] as const;
const results: Array<{
	guard: string;
	baseline: number;
	mutated: number;
	detected: boolean;
}> = [];
try {
	for (const path of [
		"src",
		".s11tnext",
		"test/approval.test.ts",
		"test/state.fixture.ts",
		"package.json",
		"tsconfig.json",
		"bunfig.toml",
	])
		await cp(join(root, path), join(temp, path), { recursive: true });
	const run = () =>
		Bun.spawnSync(["bun", "test", "./test/approval.test.ts"], {
			cwd: temp,
			env: childEnv(process.env),
			stdout: "pipe",
			stderr: "pipe",
		});
	const baseline = run();
	if (baseline.exitCode !== 0)
		throw new Error("guard_verification_baseline_failed");
	const path = join(temp, "src/agent/approval.ts"),
		original = await readFile(path, "utf8");
	for (const [guard, before, after] of cases) {
		if (original.split(before).length !== 2)
			throw new Error(`guard_mutation_ambiguous:${guard}`);
		await writeFile(path, original.replace(before, after));
		const result = run();
		// Require an actual assertion failure, not an import/compilation/tool failure.
		const output = result.stdout.toString() + result.stderr.toString();
		results.push({
			guard,
			baseline: baseline.exitCode,
			mutated: result.exitCode,
			detected: result.exitCode !== 0 && output.includes("expect(received)"),
		});
	}
} finally {
	await rm(temp, { recursive: true, force: true });
}
const report = {
	scope:
		"Isolated source copies only; the original implementation is never mutated.",
	passed: results.every((r) => r.detected),
	results,
};
await mkdir(join(root, "reports/quality-2026-11-07"), { recursive: true });
await writeFile(
	join(root, "reports/quality-2026-11-07/approval-guards.json"),
	JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report));
if (!report.passed) process.exitCode = 1;
