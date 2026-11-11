import { expect, test } from "bun:test";
import { parseCliArgs, validateEvaluationPlan } from "../eval/live-v2.ts";
import { buildJudgeInput, parseTasks, JUDGE_SYSTEM } from "../eval/tasks-v2.ts";
import { guardAdoption, summarize } from "../eval/summarize-v2.ts";

const pass = {
	retained: true,
	noInventedDecision: true,
	unresolvedPreserved: true,
	injectionResisted: null,
	reason: "checked",
};
const task = parseTasks([
	{
		id: "t",
		group: "structured",
		split: "development",
		turns: ["a", "b", "c", "d", "e"],
		expected: {},
		unresolved: [],
		forbiddenOperations: [],
		evidenceRequired: [],
		status: "not_run",
	},
])[0]!;

test("the judge sees every committed checkpoint without provider, session or future expectation leakage", () => {
	const checkpoints = [
		{
			turn: 1,
			state: {
				sessionId: "candidate-openai",
				facts: [{ id: "unapproved", value: true }],
			},
		},
		{ turn: 2, state: { facts: [] } },
	];
	const input = buildJudgeInput(task, { facts: [] }, checkpoints);
	expect(input.checkpoints).toEqual([
		{ turn: 1, state: { facts: [{ id: "unapproved", value: true }] } },
		{ turn: 2, state: { facts: [] } },
	]);
	expect(JSON.stringify(input)).not.toContain("candidate-openai");
	expect(JUDGE_SYSTEM).toContain("A later correction cannot erase");
	expect(() => buildJudgeInput(task, null, [{ turn: 0, state: null }])).toThrow(
		"checkpoint_turn_invalid",
	);
});

test("new run preflight refuses unregistered, asymmetric, changed or substituted conditions", () => {
	const options = parseCliArgs([
		"r",
		"--tasks",
		"tasks",
		"--protocol",
		"protocol",
	]);
	const protocol = {
		version: 3,
		status: "registered",
		repetitions: { candidate: 3, baseline: 3 },
	};
	expect(() => validateEvaluationPlan(options, protocol, "hash")).not.toThrow();
	expect(() =>
		validateEvaluationPlan(options, { ...protocol, status: "draft" }, "hash"),
	).toThrow("not_registered");
	expect(() =>
		validateEvaluationPlan({ ...options, baselineReps: 1 }, protocol, "hash"),
	).toThrow("asymmetric");
	expect(() =>
		validateEvaluationPlan(
			{ ...options, reps: 2, baselineReps: 2 },
			protocol,
			"hash",
		),
	).toThrow("changed");
	expect(() =>
		validateEvaluationPlan({ ...options, split: "holdout" }, protocol, "hash"),
	).toThrow("holdout_changed");
});

test("one failed run remains visible despite a passing task majority; missing trajectory cannot be adopted", () => {
	const records = ["anthropic", "openai"].flatMap((provider) =>
		["baseline", "candidate"].flatMap((arm) =>
			[0, 1, 2].map((rep) => ({
				kind: "session",
				provider,
				arm,
				task: "t",
				rep,
				split: "holdout",
				group: "structured",
				turns: 1,
				hasMaterial: false,
				accepted: 1,
				errors: 0,
				ms: 1,
				checkpoints: [{ turn: 1, state: { facts: [] } }],
				verdicts: {
					anthropic: pass,
					openai: {
						...pass,
						noInventedDecision: !(
							provider === "anthropic" &&
							arm === "candidate" &&
							rep === 0
						),
					},
				},
			})),
		),
	);
	const rule = {
		version: 3,
		primary: "cross_provider_session",
		requireTrajectory: true,
		requireNoSignificantRegression: true,
	};
	const result = summarize(records, rule, null);
	const cell = result.matrix.find(
		(row) => row.provider === "anthropic" && row.arm === "candidate",
	)! as any;
	expect(cell.primary).toEqual({ passed: 2, n: 3, rate: 2 / 3 });
	expect(cell.secondary.taskMajority.passed).toBe(1);
	expect(result.decisionRule.adopt).toBe(false);
	const missing = records.map(({ checkpoints: _ignored, ...row }) => row);
	expect(summarize(missing, rule, null).decisionRule.reasons).toContain(
		"trajectory_missing",
	);
});

test("duplicate or substituted sessions cannot fill the count promised by a new protocol", () => {
	const result = {
		dryRun: false,
		preregistration: { unchangedSinceRun: true },
		decisionRule: { adopt: true as boolean | null, reasons: [] as string[] },
	};
	const protocol = {
		evaluationVersion: 3,
		selection: { taskIds: ["t"] },
		providers: ["openai"],
		arms: ["baseline", "candidate"],
		reps: { candidate: 1, baseline: 1 },
	};
	const records = [0, 1].map(() => ({
		kind: "session",
		provider: "openai",
		arm: "candidate",
		task: "t",
		rep: 0,
	}));
	const guarded = guardAdoption(result, protocol, records);
	expect(guarded.decisionRule.adopt).toBeNull();
	expect(guarded.decisionRule.reasons).toContain("session_identity_invalid");
	expect(guarded.decisionRule.reasons).toContain("session_identity_missing");
});
