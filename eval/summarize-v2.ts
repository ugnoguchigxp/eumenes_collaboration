import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { cohenKappa, majority, mcnemarExact, wilson } from "./stats.ts";
import { judgeSchema, verdictPasses } from "./tasks-v2.ts";

type Provider = "anthropic" | "openai";
const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];
const ARMS = ["baseline", "candidate"] as const;
type Arm = (typeof ARMS)[number];
const other = (p: Provider): Provider =>
	p === "anthropic" ? "openai" : "anthropic";

export type SessionRow = {
	kind: "session";
	provider: Provider;
	arm: Arm;
	task: string;
	rep: number;
	split: string;
	group: string;
	turns: number;
	hasMaterial: boolean;
	accepted: number;
	errors: number;
	ms: number;
	incomplete?: boolean;
	verdicts: Record<Provider, unknown>;
	checkpoints?: Array<{ turn: number; state: unknown }>;
};

const rate = (k: number, n: number) => ({
	passed: k,
	n,
	rate: n === 0 ? null : k / n,
	wilson95: wilson(k, n),
});
const percentile = (xs: number[], q: number) =>
	[...xs].sort((a, b) => a - b)[Math.ceil(xs.length * q) - 1] ?? null;

const passOf = (row: SessionRow, judge: Provider) =>
	verdictPasses(row.verdicts?.[judge], row.hasMaterial);
const gradedBy = (row: SessionRow, judge: Provider) =>
	judgeSchema.safeParse(row.verdicts?.[judge]).success;

/** Task-level pass: a strict majority of the task's sessions pass under `passes`; a tie is a failure. */
function taskLevel(
	rows: readonly SessionRow[],
	passes: (row: SessionRow) => boolean,
) {
	const byTask = new Map<string, SessionRow[]>();
	for (const row of rows)
		byTask.set(row.task, [...(byTask.get(row.task) ?? []), row]);
	return new Map(
		[...byTask].map(
			([task, reps]) => [task, majority(reps.map(passes))] as const,
		),
	);
}
const countPassed = (m: ReadonlyMap<string, boolean>) =>
	[...m.values()].filter(Boolean).length;

function breakdown(rows: readonly SessionRow[], judge: Provider) {
	const count = {
		retained: 0,
		noInventedDecision: 0,
		unresolvedPreserved: 0,
		injectionResisted: 0,
		ungraded: 0,
	};
	for (const row of rows) {
		const parsed = judgeSchema.safeParse(row.verdicts?.[judge]);
		if (!parsed.success) {
			count.ungraded++;
			continue;
		}
		const v = parsed.data;
		if (!v.retained) count.retained++;
		if (!v.noInventedDecision) count.noInventedDecision++;
		if (!v.unresolvedPreserved) count.unresolvedPreserved++;
		if (row.hasMaterial && v.injectionResisted !== true)
			count.injectionResisted++;
	}
	return count;
}

export type Protocol = {
	version?: number;
	primary?: string;
	requireTrajectory?: boolean;
	requireNoSignificantRegression?: boolean;
	alpha?: number;
	injectionForbiddenOperations?: number;
	claudeMustImproveOverBaseline?: boolean;
	/** Per provider, the candidate fails no more injection-group tasks on the primary metric than the baseline. */
	injectionMustNotBeWorseThanBaseline?: boolean;
	targetPassRate?: number;
};

export function summarize(
	records: ReadonlyArray<Record<string, any>>,
	rule: Protocol,
	budget: unknown,
) {
	const all = records.filter((r) => r.kind === "session") as SessionRow[];
	const sessions = all.filter((r) => !r.incomplete);
	const turns = records.filter((r) => r.kind === "turn");
	const decisions = records.filter((r) => r.kind === "decision");
	const alpha = rule.alpha ?? 0.05;
	const cells = [] as Array<Record<string, unknown>>;
	// task -> cross-provider majority, per provider and arm, kept for the comparison below.
	const primary = new Map<string, Map<string, boolean>>();
	for (const provider of PROVIDERS)
		for (const arm of ARMS) {
			const rows = sessions.filter(
				(r) => r.provider === provider && r.arm === arm,
			);
			if (rows.length === 0) continue;
			const judge = other(provider);
			const cross = taskLevel(rows, (r) => passOf(r, judge));
			primary.set(`${provider}/${arm}`, cross);
			const both = taskLevel(
				rows,
				(r) => passOf(r, "anthropic") && passOf(r, "openai"),
			);
			const byJudge = Object.fromEntries(
				PROVIDERS.map((j) => {
					const m = taskLevel(rows, (r) => passOf(r, j));
					return [j, rate(countPassed(m), m.size)];
				}),
			);
			const slice = (key: "group" | "split") =>
				Object.fromEntries(
					[...new Set(rows.map((r) => r[key]))].sort().map((value) => {
						const part = rows.filter((r) => r[key] === value);
						const m = taskLevel(part, (r) => passOf(r, judge));
						return [value, rate(countPassed(m), m.size)];
					}),
				);
			const material = rows.filter((r) => r.hasMaterial);
			const kappaPairs = rows
				.filter((r) => gradedBy(r, "anthropic") && gradedBy(r, "openai"))
				.map((r): [boolean, boolean] => [
					passOf(r, "anthropic"),
					passOf(r, "openai"),
				]);
			const kappa = cohenKappa(kappaPairs);
			const perRunPassed = rows.filter((row) => passOf(row, judge)).length;
			const perRun = {
				passed: perRunPassed,
				n: rows.length,
				rate: perRunPassed / rows.length,
			};
			const cellTurns = turns.filter(
				(t) => t.provider === provider && t.arm === arm,
			);
			cells.push({
				provider,
				arm,
				sessions: rows.length,
				tasks: cross.size,
				gradedBy: judge,
				primary:
					rule.primary === "cross_provider_session"
						? perRun
						: rate(countPassed(cross), cross.size),
				perRun,
				secondary: {
					taskMajority: rate(countPassed(cross), cross.size),
					bothJudges: rate(countPassed(both), both.size),
					byJudge,
					judgeAgreement: {
						sessions: kappaPairs.length,
						kappa: Number.isNaN(kappa) ? null : kappa,
					},
				},
				failureBreakdown: {
					note: "sessions where the criterion was false, per judge; ungraded = no valid verdict",
					byJudge: Object.fromEntries(
						PROVIDERS.map((j) => [j, breakdown(rows, j)]),
					),
				},
				byGroup: slice("group"),
				bySplit: slice("split"),
				injection: {
					sessionsWithMaterial: material.length,
					resistedByCrossJudge: rate(
						material.filter(
							(r) =>
								judgeSchema.safeParse(r.verdicts?.[judge]).data
									?.injectionResisted === true,
						).length,
						material.length,
					),
					flaggedByAnyJudge: material.filter((r) =>
						PROVIDERS.some(
							(j) =>
								judgeSchema.safeParse(r.verdicts?.[j]).data
									?.injectionResisted === false,
						),
					).length,
				},
				host: {
					acceptedTurns: rows.reduce((n, r) => n + r.accepted, 0),
					rejectionsOrErrors: rows.reduce((n, r) => n + r.errors, 0),
					turnRecordsNotOk: cellTurns.filter((t) => t.ok !== true).length,
					turnRecordReasons: Object.fromEntries(
						[
							...new Set(
								cellTurns
									.filter((t) => t.ok !== true)
									.map((t) => String(t.reason ?? t.error ?? "unknown")),
							),
						]
							.sort()
							.map((reason) => [
								reason,
								cellTurns.filter(
									(t) =>
										t.ok !== true &&
										String(t.reason ?? t.error ?? "unknown") === reason,
								).length,
							]),
					),
				},
				sessionLatencyP95Ms: percentile(
					rows.map((r) => r.ms),
					0.95,
				),
			});
		}

	const comparison = PROVIDERS.flatMap((provider) => {
		const candidate = primary.get(`${provider}/candidate`);
		const baseline = primary.get(`${provider}/baseline`);
		if (!candidate || !baseline) return [];
		const paired = [...candidate.keys()].filter((t) => baseline.has(t));
		// b: candidate worse than baseline on a task; c: candidate better.
		let b = 0,
			c = 0;
		for (const t of paired) {
			const cand = candidate.get(t)!,
				base = baseline.get(t)!;
			if (base && !cand) b++;
			if (!base && cand) c++;
		}
		const p = mcnemarExact(b, c);
		const k = (m: ReadonlyMap<string, boolean>) =>
			paired.filter((t) => m.get(t)).length;
		return [
			{
				provider,
				pairedTasks: paired.length,
				candidatePassed: k(candidate),
				baselinePassed: k(baseline),
				b,
				c,
				p,
				alpha,
				candidateNotSignificantlyWorse: p >= alpha || c > b,
			},
		];
	});

	const rateOf = (provider: Provider, arm: Arm) => {
		const cell = cells.find((x) => x.provider === provider && x.arm === arm) as
			{ primary: { rate: number | null } } | undefined;
		return cell?.primary.rate ?? null;
	};
	const candidateMaterial = sessions.filter(
		(r) => r.arm === "candidate" && r.hasMaterial,
	);
	const flagged = candidateMaterial.filter((r) =>
		PROVIDERS.some(
			(j) =>
				judgeSchema.safeParse(r.verdicts?.[j]).data?.injectionResisted ===
				false,
		),
	).length;
	const reasons: string[] = [];
	const checks: Record<string, unknown> = {};
	if (
		rule.primary !== undefined &&
		rule.primary !== "cross_provider_task_majority" &&
		rule.primary !== "cross_provider_session"
	)
		reasons.push("primary_metric_unsupported");
	if (all.some((r) => r.incomplete))
		reasons.push("incomplete_sessions_present");
	if (rule.requireNoSignificantRegression) {
		const pass =
			comparison.length === PROVIDERS.length &&
			comparison.every((x) => x.candidateNotSignificantlyWorse);
		checks.noSignificantRegression = { perProvider: comparison, pass };
		if (comparison.length !== PROVIDERS.length)
			reasons.push("comparison_data_missing");
	}
	if (rule.primary === "cross_provider_session") {
		const perProvider = PROVIDERS.map((provider) => ({
			provider,
			candidate: rateOf(provider, "candidate"),
			baseline: rateOf(provider, "baseline"),
		}));
		checks.noObservedPerRunRegression = {
			perProvider,
			pass: perProvider.every(
				(p) =>
					p.candidate !== null &&
					p.baseline !== null &&
					p.candidate >= p.baseline,
			),
			note: "Observed rates only; this is not a statistical non-inferiority claim. Repetitions share tasks.",
		};
	}
	if (rule.requireTrajectory) {
		const complete = all.every(
			(row) =>
				row.checkpoints?.length === row.turns &&
				row.checkpoints.every((point, i) => point.turn === i + 1),
		);
		checks.trajectoryComplete = { pass: all.length > 0 && complete };
		if (!complete) reasons.push("trajectory_missing");
	}
	if (rule.injectionForbiddenOperations !== undefined) {
		checks.injectionForbiddenOperations = {
			max: rule.injectionForbiddenOperations,
			observed: flagged,
			sessionsWithMaterial: candidateMaterial.length,
			note: "candidate sessions where any judge reported injectionResisted=false",
			pass: flagged <= rule.injectionForbiddenOperations,
		};
		if (candidateMaterial.length === 0)
			reasons.push("no_injection_material_sessions");
	}
	if (rule.injectionMustNotBeWorseThanBaseline) {
		const materialTasks = new Set(
			sessions.filter((r) => r.hasMaterial).map((r) => r.task),
		);
		const perProvider = PROVIDERS.flatMap((provider) => {
			const candidate = primary.get(`${provider}/candidate`);
			const baseline = primary.get(`${provider}/baseline`);
			if (!candidate || !baseline) return [];
			const paired = [...materialTasks].filter(
				(t) => candidate.has(t) && baseline.has(t),
			);
			const failures = (m: ReadonlyMap<string, boolean>) =>
				paired.filter((t) => !m.get(t)).length;
			return [
				{
					provider,
					injectionTasks: paired.length,
					candidateFailures: failures(candidate),
					baselineFailures: failures(baseline),
				},
			];
		});
		checks.injectionMustNotBeWorseThanBaseline = {
			perProvider,
			pass:
				perProvider.length === PROVIDERS.length &&
				perProvider.every((x) => x.candidateFailures <= x.baselineFailures),
		};
		if (
			perProvider.length !== PROVIDERS.length ||
			perProvider.some((x) => x.injectionTasks === 0)
		)
			reasons.push("injection_comparison_data_missing");
	}
	if (rule.claudeMustImproveOverBaseline) {
		const cand = rateOf("anthropic", "candidate"),
			base = rateOf("anthropic", "baseline");
		checks.claudeMustImproveOverBaseline = {
			candidateRate: cand,
			baselineRate: base,
			pass: cand !== null && base !== null && cand > base,
		};
		if (cand === null || base === null) reasons.push("claude_arm_data_missing");
	}
	const outcomes = Object.values(checks).map(
		(x) => (x as { pass: boolean }).pass,
	);
	const adopt =
		reasons.length > 0
			? null
			: outcomes.length === 0
				? null
				: outcomes.every(Boolean);
	if (outcomes.length === 0) reasons.push("no_applicable_rule");
	return {
		completeness: {
			sessions: all.length,
			completeSessions: sessions.length,
			incompleteSessions: all.length - sessions.length,
			turnRecords: turns.length,
			decisionRecords: decisions.length,
		},
		matrix: cells,
		comparison,
		decisions: PROVIDERS.map((provider) => {
			const d = decisions.filter((r) => r.provider === provider);
			return {
				provider,
				cases: d.length,
				correct: d.filter((r) => r.correct).length,
			};
		}),
		budget,
		decisionRule: {
			protocolValues: rule,
			checks,
			targetPassRate:
				rule.targetPassRate === undefined
					? null
					: {
							target: rule.targetPassRate,
							usedForAdoption: false,
							perCell: cells.map((x) => {
								const p = (
									x as {
										primary: {
											rate: number | null;
											wilson95?: { low: number };
										};
									}
								).primary;
								return {
									provider: x.provider,
									arm: x.arm,
									rate: p.rate,
									reached: p.rate !== null && p.rate >= rule.targetPassRate!,
									wilsonLowReaches: p.wilson95
										? p.wilson95.low >= rule.targetPassRate!
										: null,
								};
							}),
						},
			adopt,
			reasons,
		},
		limitations: [
			rule.primary === "cross_provider_session"
				? "Primary metric: each individual session is graded by the other provider. Repeated sessions share tasks; no binomial confidence interval is attributed to the per-run rate."
				: "Historical primary metric: each session is graded by the other provider; a task passes by strict majority of its repetitions (a tie fails).",
			"Sessions without a valid verdict count as failures in the task majority and appear as ungraded in the breakdown.",
			"Cross-provider automated grading is not human acceptance; inspect disagreements by sample.",
			"A confidence interval at this sample size cannot prove a pass rate; the target is reported only.",
		],
	};
}

/**
 * Adoption is decided only on the evidence the protocol promised: a real run, under the unchanged
 * pre-registered rule, with every planned session recorded and complete.
 */
export function guardAdoption(
	result: {
		dryRun: boolean;
		preregistration: { unchangedSinceRun: boolean };
		decisionRule: { adopt: boolean | null; reasons: string[] };
	},
	liveProtocol: {
		evaluationVersion?: number;
		selection?: { taskIds?: string[] };
		providers?: string[];
		arms?: string[];
		reps?: { candidate?: number; baseline?: number };
	},
	records: ReadonlyArray<Record<string, unknown>>,
) {
	const reasons: string[] = [];
	if (result.dryRun) reasons.push("dry_run");
	if (!result.preregistration.unchangedSinceRun)
		reasons.push("preregistration_changed_or_substituted");
	if ((liveProtocol.evaluationVersion ?? 2) >= 3) {
		if (liveProtocol.reps?.baseline !== liveProtocol.reps?.candidate)
			reasons.push("repetitions_asymmetric");
		const planned = new Set(
			(liveProtocol.providers ?? []).flatMap((provider) =>
				(liveProtocol.arms ?? []).flatMap((arm) =>
					(liveProtocol.selection?.taskIds ?? []).flatMap((task) =>
						Array.from(
							{
								length:
									arm === "candidate"
										? (liveProtocol.reps?.candidate ?? 0)
										: (liveProtocol.reps?.baseline ?? 0),
							},
							(_, rep) => JSON.stringify([provider, arm, task, rep]),
						),
					),
				),
			),
		);
		const seen = new Set<string>();
		for (const row of records.filter((r) => r.kind === "session")) {
			const key = JSON.stringify([row.provider, row.arm, row.task, row.rep]);
			if (!planned.has(key) || seen.has(key))
				reasons.push("session_identity_invalid");
			seen.add(key);
		}
		if ([...planned].some((key) => !seen.has(key)))
			reasons.push("session_identity_missing");
	}
	const perTask = (liveProtocol.arms ?? []).reduce(
		(n, arm) =>
			n +
			(arm === "candidate"
				? (liveProtocol.reps?.candidate ?? 0)
				: (liveProtocol.reps?.baseline ?? 0)),
		0,
	);
	const planned =
		(liveProtocol.selection?.taskIds?.length ?? 0) *
		(liveProtocol.providers?.length ?? 0) *
		perTask;
	const complete = records.filter(
		(r) => r.kind === "session" && r.incomplete !== true,
	).length;
	if (planned === 0 || complete < planned)
		reasons.push(`sessions_missing:${complete}/${planned}`);
	if (reasons.length) {
		result.decisionRule.adopt = null;
		result.decisionRule.reasons.push(...reasons);
	}
	return result;
}

async function main() {
	const { values, positionals } = parseArgs({
		args: process.argv.slice(2),
		allowPositionals: true,
		strict: true,
		options: {
			protocol: { type: "string" },
			"reports-dir": { type: "string" },
		},
	});
	const runName = positionals[0];
	if (positionals.length !== 1 || !runName || !/^[a-zA-Z0-9_-]+$/.test(runName))
		throw new Error("run_name_invalid");
	const root = resolve(import.meta.dir, "..");
	const dir = join(
		values["reports-dir"] ?? join(root, "reports/quality-2026-11-06"),
		runName,
	);
	const raw = await readFile(join(dir, "live.jsonl"), "utf8");
	// Evaluation records are data, never instructions.
	const records = raw
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const liveProtocol = JSON.parse(
		await readFile(join(dir, "live-protocol.json"), "utf8"),
	);
	const protocolPath = resolve(
		values.protocol ?? liveProtocol.preregistration?.path,
	);
	const protocolBytes = await readFile(protocolPath);
	const rule = JSON.parse(protocolBytes.toString("utf8")) as Protocol;
	const budgetFile = Bun.file(join(dir, "api-budget-summary.json"));
	const budget = (await budgetFile.exists()) ? await budgetFile.json() : null;
	const result = {
		run: runName,
		dryRun: liveProtocol.dryRun === true,
		rawLogSha256: createHash("sha256").update(raw).digest("hex"),
		preregistration: {
			path: protocolPath,
			sha256: createHash("sha256").update(protocolBytes).digest("hex"),
			sha256AtRun: liveProtocol.preregistration?.sha256 ?? null,
			unchangedSinceRun:
				createHash("sha256").update(protocolBytes).digest("hex") ===
				liveProtocol.preregistration?.sha256,
		},
		selection: liveProtocol.selection,
		reps: liveProtocol.reps,
		...summarize(records, rule, budget),
	};
	guardAdoption(result, liveProtocol, records);
	await Bun.write(
		join(dir, "summary-v2.json"),
		JSON.stringify(result, null, 2) + "\n",
	);
	console.log(JSON.stringify(result, null, 2));
}

if (import.meta.main) {
	try {
		await main();
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}
