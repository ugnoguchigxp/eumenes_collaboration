import { expect, test } from "bun:test";
import development from "../eval/proactive/development.json";
import holdout from "../eval/proactive/holdout.json";
import { checkInventory, summarizeRuns } from "../eval/proactive/index.ts";

const checked = checkInventory(development, holdout);
const task = checked.holdout[0]!;
const run = {
	taskId: task.id,
	mode: "A",
	repetition: 1,
	status: "completed",
	conditionsMet: true,
	followUps: 0,
	rework: 0,
	unnecessaryProposals: 0,
	boundaryViolations: 0,
	foregroundMs: [200, 400],
};

test("proactive inventory separates development and holdout and forbids duplicate cases", () => {
	expect(checked.development).toHaveLength(6);
	expect(checked.holdout).toHaveLength(24);
	expect(() =>
		checkInventory(development, [
			{ ...holdout[0], id: development[0]!.id },
			...holdout.slice(1),
		]),
	).toThrow("proactive_duplicate_task_id");
});

test("failed runs remain in the denominator even when some conditions were met", () => {
	const summary = summarizeRuns(
		[run, { ...run, repetition: 2, status: "failed", foregroundMs: [] }],
		[task],
		["A"],
	);
	expect(summary[0]).toMatchObject({
		mode: "A",
		runs: 2,
		conditionsMet: 1,
		unassistedCompletion: 1,
		foregroundP95Ms: 400,
	});
});

test("a follow-up or boundary violation prevents unassisted completion", () => {
	const summary = summarizeRuns(
		[
			{ ...run, followUps: 1 },
			{ ...run, repetition: 2, boundaryViolations: 1 },
		],
		[task],
		["A"],
	);
	expect(summary[0]).toMatchObject({
		conditionsMet: 2,
		unassistedCompletion: 0,
		followUps: 1,
		boundaryViolations: 1,
	});
});

test("the same case and repetition are required in every compared mode", () => {
	const repeat = { ...run, repetition: 2 };
	const other = { ...run, mode: "B" };
	expect(() =>
		summarizeRuns([run, repeat, other, other], [task], ["A", "B"]),
	).toThrow("proactive_incomplete_or_unpaired_runs");
	expect(() => summarizeRuns([run, repeat, other], [task], ["A", "B"])).toThrow(
		"proactive_incomplete_or_unpaired_runs",
	);
	expect(
		summarizeRuns(
			[run, repeat, other, { ...other, repetition: 2 }],
			[task],
			["A", "B"],
		),
	).toHaveLength(2);
});
