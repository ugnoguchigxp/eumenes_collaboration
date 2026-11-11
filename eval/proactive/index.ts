import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { z } from "zod";
import protocol from "./protocol.json";

export const groups = ["preparation", "blockage", "wait", "quiet"] as const;
const text = z.string().trim().min(1).max(1500);
const taskSchema = z
	.strictObject({
		id: z.string().regex(/^[a-z]+(?:-[a-z]+)*$/),
		group: z.enum(groups),
		opening: text,
		update: text,
		criteria: text,
		followUp: text.optional(),
	})
	.refine(
		(task) =>
			Boolean(task.followUp) ===
			(task.group === "preparation" || task.group === "blockage"),
		{ path: ["followUp"], message: "follow-up does not match the task group" },
	);

export type Task = z.infer<typeof taskSchema>;

export function checkInventory(development: unknown, holdout: unknown) {
	const dev = z.array(taskSchema).parse(development);
	const evaluation = z.array(taskSchema).parse(holdout);
	const all = [...dev, ...evaluation];
	if (new Set(all.map((task) => task.id)).size !== all.length)
		throw new Error("proactive_duplicate_task_id");
	if (
		dev.length !== protocol.developmentCount ||
		groups.some(
			(group) =>
				!dev.some((task) => task.group === group) ||
				evaluation.filter((task) => task.group === group).length !==
					protocol.holdoutPerGroup,
		)
	)
		throw new Error("proactive_task_split_invalid");
	return { development: dev, holdout: evaluation };
}

const runSchema = z.strictObject({
	taskId: z.string(),
	mode: z.enum(["A", "A+", "B", "C"]),
	repetition: z.number().int().positive(),
	status: z.enum(["completed", "incomplete", "failed"]),
	conditionsMet: z.boolean(),
	followUps: z.number().int().nonnegative(),
	rework: z.number().int().nonnegative(),
	unnecessaryProposals: z.number().int().nonnegative(),
	boundaryViolations: z.number().int().nonnegative(),
	foregroundMs: z.array(z.number().nonnegative()),
});

type Mode = z.infer<typeof runSchema>["mode"];

/** Scoring consumes observations and human verdicts, including failed runs. */
export function summarizeRuns(raw: unknown, tasks: Task[], modes: Mode[]) {
	const runs = z.array(runSchema).parse(raw);
	const taskIds = new Set(tasks.map((task) => task.id));
	const keys = runs.map((run) =>
		JSON.stringify([run.taskId, run.mode, run.repetition]),
	);
	if (
		taskIds.size !== tasks.length ||
		!tasks.length ||
		!modes.length ||
		new Set(modes).size !== modes.length ||
		new Set(keys).size !== keys.length ||
		runs.length !== tasks.length * modes.length * protocol.repetitions ||
		runs.some(
			(run) =>
				!taskIds.has(run.taskId) ||
				!modes.includes(run.mode) ||
				run.repetition > protocol.repetitions,
		)
	)
		throw new Error("proactive_incomplete_or_unpaired_runs");

	return modes.map((mode) => {
		const selected = runs.filter((run) => run.mode === mode);
		const count = (predicate: (run: (typeof runs)[number]) => boolean) =>
			selected.filter(predicate).length;
		const sum = (
			key:
				"rework" | "followUps" | "unnecessaryProposals" | "boundaryViolations",
		) => selected.reduce((total, run) => total + run[key], 0);
		const meetsConditions = (run: (typeof runs)[number]) =>
			run.status === "completed" && run.conditionsMet;
		const meetsGoal = (run: (typeof runs)[number]) =>
			meetsConditions(run) &&
			run.followUps === 0 &&
			run.boundaryViolations === 0;
		const latency = selected
			.flatMap((run) => run.foregroundMs)
			.sort((a, b) => a - b);
		return {
			mode,
			runs: selected.length,
			completed: count((run) => run.status === "completed"),
			conditionsMet: count(meetsConditions),
			unassistedCompletion: count(meetsGoal),
			followUps: sum("followUps"),
			rework: sum("rework"),
			unnecessaryProposals: sum("unnecessaryProposals"),
			boundaryViolations: sum("boundaryViolations"),
			foregroundP95Ms: latency[Math.ceil(latency.length * 0.95) - 1] ?? null,
			cases: selected.map((run) => ({ ...run, meetsGoal: meetsGoal(run) })),
		};
	});
}

if (import.meta.main) {
	const { values } = parseArgs({
		options: {
			scores: { type: "string" },
			modes: { type: "string", default: "A" },
			split: { type: "string", default: "holdout" },
		},
	});
	const filenames = ["development.json", "holdout.json", "protocol.json"];
	const bytes = await Promise.all(
		filenames.map((name) => readFile(new URL(name, import.meta.url))),
	);
	const [development, holdout] = bytes;
	const tasks = checkInventory(
		JSON.parse(development!.toString()),
		JSON.parse(holdout!.toString()),
	);
	const split = z.enum(["development", "holdout"]).parse(values.split);
	const modes = z.array(runSchema.shape.mode).parse(values.modes.split(","));
	const scores = values.scores
		? summarizeRuns(
				JSON.parse(await readFile(values.scores, "utf8")),
				tasks[split],
				modes,
			)
		: undefined;
	console.log(
		JSON.stringify(
			{
				status: protocol.status,
				development: tasks.development.length,
				holdout: tasks.holdout.length,
				plannedHoldoutRuns:
					tasks.holdout.length * protocol.modes.length * protocol.repetitions,
				sha256: Object.fromEntries(
					filenames.map((name, index) => [
						name,
						createHash("sha256").update(bytes[index]!).digest("hex"),
					]),
				),
				...(scores ? { split, scores } : {}),
			},
			null,
			2,
		),
	);
}
