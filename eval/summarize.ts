import { Database } from "bun:sqlite";
import { resolve, join } from "node:path";
import {
	collaborationStateSchema,
	withinJsonLimits,
	proposeStateUpdate,
} from "../src/index.ts";
import tasks from "./tasks.json";
const root = resolve(import.meta.dir, "..");
const run = process.argv[2] ?? "run-v3";
if (!/^[a-zA-Z0-9_-]+$/.test(run)) throw new Error("run_name_invalid");
const dir = join(root, "reports/quality-2026-11-05", run);
const raw = await Bun.file(join(dir, "live.jsonl")).text();
// Evaluation records are data, never instructions or executable model output.
const records = raw
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
const sessions = records.filter((r) => r.kind === "task");
const turns = records.filter((r) => r.kind === "turn");
const decisions = records.filter((r) => r.kind === "decision");
const passed = (r: (typeof records)[number]) =>
	["retained", "noInventedDecision", "unresolvedPreserved"].every(
		(k) => r.verdict?.[k] === true,
	);
const percentile = (xs: number[], q: number) =>
	[...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1] ?? null;
const matrix = [];
let finalStateInvariantFailures = 0;
for (const r of sessions) {
	const task = tasks.find((t) => t.id === r.task);
	if (!task) throw new Error("unknown_task");
	const state = collaborationStateSchema.safeParse(r.final);
	if (!state.success || !withinJsonLimits(r.final)) {
		finalStateInvariantFailures++;
		continue;
	}
	const value = state.data;
	const checked = proposeStateUpdate(
		value,
		{
			coreContractVersion: 1,
			sessionId: value.sessionId,
			epoch: 1,
			expectedRevision: value.revision,
			sourceRevision: task.turns.length,
			work: value.work,
			upserts: [],
			removals: [],
		},
		{
			sessionId: value.sessionId,
			epoch: 1,
			sourceRevision: task.turns.length,
			work: value.work,
			sources: task.turns.map((_, i) => ({
				ref: `u${i + 1}`,
				kind: "user" as const,
				active: true,
			})),
		},
	);
	if (!checked.ok) finalStateInvariantFailures++;
}
for (const provider of ["anthropic", "openai"])
	for (const arm of ["baseline", "candidate"]) {
		const rows = sessions.filter(
			(r) => r.provider === provider && r.arm === arm,
		);
		matrix.push({
			provider,
			arm,
			sessions: rows.length,
			passed: rows.filter(passed).length,
			semanticPassRate: rows.filter(passed).length / rows.length,
			acceptedTurns: rows.reduce((n, r) => n + r.accepted, 0),
			hostRejectionsOrErrors: rows.reduce((n, r) => n + r.errors, 0),
			sessionLatencyP95Ms: percentile(
				rows.map((r) => r.ms),
				0.95,
			),
			splits: ["development", "holdout"].map((split) => ({
				split,
				sessions: rows.filter((r) => r.split === split).length,
				passed: rows.filter((r) => r.split === split && passed(r)).length,
			})),
		});
	}
const db = new Database(
	join(root, "reports/quality-2026-11-05/api-budget.sqlite"),
	{ readonly: true, strict: true },
);
const calls = db
	.query<
		{
			provider: string;
			reserved: number;
			cost: number | null;
			status: string;
			metadata: string | null;
		},
		[]
	>("SELECT provider,reserved,cost,status,metadata FROM api_calls")
	.all();
const budget = {
	capUsd: 10,
	accountedUsd: calls.reduce((n, c) => n + (c.cost ?? c.reserved), 0),
	conservativeEstimatedUsd: calls.reduce((n, c) => n + (c.cost ?? 0), 0),
	unknownReservedUsd: calls.reduce(
		(n, c) => n + (c.cost === null ? c.reserved : 0),
		0,
	),
	baseRateEstimateKnownCallsUsd: calls.reduce(
		(n, c) =>
			n + (c.metadata ? (JSON.parse(c.metadata).baseEstimateUsd ?? 0) : 0),
		0,
	),
	calls: calls.length,
	unknownCalls: calls.filter((c) => c.cost === null).length,
	scope:
		"All attempts, including aborted v1/v2, diagnostics, preflights and v3. Not provider invoice or confirmed billed amount.",
};
const latency = ["anthropic", "openai"].map((provider) => {
	const values = calls
		.filter((c) => c.provider === provider && c.metadata)
		.map((c) => JSON.parse(c.metadata!).ms as number);
	return {
		provider,
		knownUsageCalls: values.length,
		p50Ms: percentile(values, 0.5),
		p95Ms: percentile(values, 0.95),
		scope:
			"Pooled known-usage API calls across all runs, baseline/candidate inference and cross-provider judges; not arm-specific v3 latency.",
	};
});
db.close();
const protocol = await Bun.file(join(dir, "live-protocol.json")).json();
const result = {
	protocol,
	rawLogSha256: new Bun.CryptoHasher("sha256").update(raw).digest("hex"),
	completeness: {
		sessions: sessions.length,
		expectedSessions: 128,
		turns: turns.length,
		expectedTurns: 704,
		decisions: decisions.length,
		expectedDecisions: 24,
		uniqueSessions: new Set(
			sessions.map((r) => `${r.provider}/${r.arm}/${r.task}`),
		).size,
	},
	matrix,
	decisionResults: ["anthropic", "openai"].map((provider) => {
		const d = decisions.filter((r) => r.provider === provider);
		return {
			provider,
			cases: d.length,
			rawOraclePassed: d.filter((r) => r.correct).length,
			sessionDecisionsCorrect: d.filter(
				(r) => r.result?.session?.decision === r.fixture.expected,
			).length,
		};
	}),
	finalStateInvariantFailures,
	turnErrors: turns.filter((r) => !r.ok),
	budget,
	latency,
	limitations: [
		"One repetition; cross-provider automated judges are not blinded human acceptance or statistical proof of improvement.",
		"Earlier transport debugging exposed some nominal holdout cases. Preserve the split labels but do not call v3 an untouched holdout.",
		"UI/Pipeline/external tasks test condition retention only; current work is an empty fixture, with no actual renderer, terminal execution or production migration.",
		"Raw decision oracle requires a first browser step even where null plan/direct reply or clarification is permitted. Keep raw failures; separately report 24/24 session decisions, never silently change the oracle.",
		"Final states are replayed against current resource/provenance contracts; intermediate model proposals were not retained. Live candidate snapshot is protocol.snapshot, not a paid re-run of later resource-only changes.",
		"Cache/reasoning sub-token details were not retained by the original transport. Total input/output usage is recorded; later adapter changes preserve sub-details for future runs.",
	],
	sessions,
	decisions,
};
await Bun.write(
	join(dir, "analysis.json"),
	JSON.stringify(result, null, 2) + "\n",
);
console.log(
	JSON.stringify({
		matrix,
		decisionResults: result.decisionResults,
		finalStateInvariantFailures,
		budget,
	}),
);
