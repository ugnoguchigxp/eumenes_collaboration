import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import development from "./development.json";
import holdout from "./holdout.json";
import {
	checkFreshEvaluation,
	checkInventory,
	summarizeRuns,
} from "./index.ts";

const original = checkInventory(development, holdout);

type Assessment = {
	conditionsMet: boolean;
	rework: unknown[];
	unnecessaryProposals: number;
	boundaryViolations: number;
};
type Trial = {
	taskId: string;
	variant: string;
	repetition: number;
	openingKey: string;
	status: string;
	error?: string;
	turns?: {
		status: string;
		elapsedMs: number;
		error?: string;
		answer?: string;
		work?: { title: string; definition: unknown };
		state?: { facts: { sourceRefs: string[] }[] };
	}[];
	assessment?: {
		before: Assessment;
		final: Assessment;
		followUps: number;
		followUpStatus?: string;
	};
};

const [path, freshPath] = Bun.argv.slice(2);
if (!path)
	throw new Error(
		"usage: bun eval/proactive/summarize-a-holdout.ts <results.jsonl[.gz]> [fresh-tasks.json]",
	);
const tasksPath = freshPath ?? new URL("./holdout.json", import.meta.url);
const tasksBytes = await readFile(tasksPath);
const tasks = freshPath
	? checkFreshEvaluation(JSON.parse(tasksBytes.toString()), [
			...original.development,
			...original.holdout,
		])
	: original.holdout;
const bytes = await readFile(path);
const raw = path.endsWith(".gz") ? gunzipSync(bytes) : bytes;
const rows = raw
	.toString()
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
const registration = rows[0];
const holdoutHash = createHash("sha256").update(tasksBytes).digest("hex");
const variants = ["before", "after"] as const;
if (
	registration?.split !== (freshPath ? "fresh-holdout" : "holdout") ||
	registration.holdoutSha256 !== holdoutHash ||
	rows.at(-1)?.kind !== "usage" ||
	registration.plannedTrials !==
		tasks.length * registration.repetitions * variants.length
)
	throw new Error("a_holdout_registration_mismatch");

function score(row: Trial) {
	const before = row.assessment?.before;
	const final = row.assessment?.final;
	const turns = row.turns ?? [];
	const followUps = Math.max(0, turns.length - 2);
	if (row.assessment && followUps !== row.assessment.followUps)
		throw new Error(`a_holdout_follow_up_count_mismatch:${row.taskId}`);
	const completed =
		row.status === "ok" &&
		final &&
		(!followUps || row.assessment?.followUpStatus === "ok");
	return {
		taskId: row.taskId,
		mode: "A",
		repetition: row.repetition,
		status: completed
			? "completed"
			: row.status === "failed"
				? "failed"
				: "incomplete",
		conditionsMet: completed ? final.conditionsMet : false,
		followUps,
		rework: final?.rework.length ?? 0,
		unnecessaryProposals: Math.max(
			before?.unnecessaryProposals ?? 0,
			final?.unnecessaryProposals ?? 0,
		),
		boundaryViolations: Math.max(
			before?.boundaryViolations ?? 0,
			final?.boundaryViolations ?? 0,
		),
		foregroundMs: turns
			.slice(1)
			.map((turn: { elapsedMs: number }) => turn.elapsedMs),
	};
}

function percentile(times: number[], quantile: number) {
	const sorted = [...times].sort((a, b) => a - b);
	return sorted[Math.ceil(sorted.length * quantile) - 1] ?? null;
}

const records: Trial[] = rows.filter((row) => row.taskId);
if (records.length !== registration.plannedTrials)
	throw new Error("a_holdout_wrong_trial_count");
const data = variants.map((variant) => {
	const selected = records.filter((row) => row.variant === variant);
	const scores = selected.map(score);
	const summary = summarizeRuns(scores, tasks, ["A"])[0];
	if (!summary) throw new Error("a_holdout_missing_variant");
	const { cases, ...metrics } = summary;
	const updates = scores.flatMap(({ foregroundMs }) =>
		foregroundMs.slice(0, 1),
	);
	return {
		variant,
		...metrics,
		updateMs: {
			samples: updates.length,
			median: percentile(updates, 0.5),
			p95: percentile(updates, 0.95),
		},
		runsWithoutAssessment: selected.filter((row) => !row.assessment).length,
		incomplete: selected
			.filter((_, i) => scores[i]?.status !== "completed")
			.map((row) => ({
				taskId: row.taskId,
				repetition: row.repetition,
				status: row.status,
				error: row.error ?? row.turns?.at(-1)?.error ?? null,
			})),
		groups: Object.fromEntries(
			[...new Set(tasks.map((t) => t.group))].map((group) => {
				const ids = tasks.filter((t) => t.group === group).map((t) => t.id);
				const members = cases.filter((c) => ids.includes(c.taskId));
				return [
					group,
					{
						trials: members.length,
						completed: members.filter((c) => c.status === "completed").length,
						conditionsMet: members.filter((c) => c.conditionsMet).length,
						main: members.filter((c) => c.meetsGoal).length,
						followUps: members.reduce((sum, c) => sum + c.followUps, 0),
						unnecessaryProposals: members.reduce(
							(sum, c) => sum + c.unnecessaryProposals,
							0,
						),
					},
				];
			}),
		),
		cases,
	};
});
const opening = (row: Trial) => {
	const turn = row.turns?.[0];
	if (turn?.status !== "completed") return null;
	return [
		turn.answer,
		turn.work?.title,
		turn.work?.definition,
		turn.state?.facts?.map((fact: { sourceRefs: string[] }) => ({
			...fact,
			sourceRefs: fact.sourceRefs.map((ref) => ref.split(":").at(-1)),
		})),
	];
};
const [baseline, revised] = data;
if (!baseline || !revised) throw new Error("a_holdout_missing_variant");
const pairs = baseline.cases.map((before) => {
	const key = (row: { taskId: string; repetition: number }) =>
		row.taskId === before.taskId && row.repetition === before.repetition;
	const after = revised.cases.find(key);
	const rawPair = records.filter(key);
	if (
		!after ||
		rawPair.length !== 2 ||
		rawPair[0]?.openingKey !== rawPair[1]?.openingKey
	)
		throw new Error("a_holdout_pair_mismatch");
	const inputs = rawPair.map(opening);
	if (
		inputs.every(Boolean) &&
		!isDeepStrictEqual(...(inputs as [unknown, unknown]))
	)
		throw new Error("a_holdout_pair_initial_state_mismatch");
	const worse =
		(before.status === "completed" && after.status !== "completed") ||
		(before.conditionsMet && !after.conditionsMet) ||
		after.followUps > before.followUps ||
		after.rework > before.rework ||
		after.boundaryViolations > before.boundaryViolations;
	const improved =
		after.status === "completed" &&
		after.conditionsMet &&
		(after.followUps < before.followUps || after.rework < before.rework);
	return {
		taskId: before.taskId,
		repetition: before.repetition,
		verdict: worse ? "worse" : improved ? "improved" : "same",
	};
});
const caseVerdicts = tasks.map(({ id, group }) => {
	const verdicts = pairs
		.filter((pair) => pair.taskId === id)
		.sort((a, b) => a.repetition - b.repetition)
		.map((pair) => pair.verdict);
	const before = baseline.cases.filter((row) => row.taskId === id);
	const after = revised.cases.filter((row) => row.taskId === id);
	const splitBaseline =
		before.some((row) => row.meetsGoal) &&
		!before.every((row) => row.meetsGoal);
	const improved =
		verdicts.includes("improved") &&
		(!splitBaseline || after.every((row) => row.meetsGoal));
	const worse = verdicts.includes("worse");
	return {
		taskId: id,
		group,
		verdict: worse
			? improved
				? "mixed"
				: "worse"
			: improved
				? "improved"
				: "same",
		pairs: verdicts,
	};
});
const usage = rows
	.at(-1)
	.variants.map(
		({ name, calls }: { name: string; calls: { status: string }[] }) => ({
			variant: name,
			calls: calls.length,
			failed: calls.filter(({ status }) => status !== "ok").length,
		}),
	);
console.log(
	JSON.stringify(
		{
			resultSha256: createHash("sha256").update(raw).digest("hex"),
			variants: data,
			caseVerdicts,
			usage,
		},
		null,
		2,
	),
);
