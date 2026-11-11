import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { cases } from "./cases.mjs";

const [dir] = Bun.argv.slice(2);
if (!dir) throw Error("usage: summarize.mjs <result directory>");
const read = async (name) => readFile(join(dir, name), "utf8");
const rows = (await read("raw.jsonl")).trim().split("\n").map(JSON.parse);
const grades = JSON.parse(await read("grades.json"));
const registration = JSON.parse(await read("registration.json"));
const gradeById = new Map(grades.map((grade) => [grade.id, grade]));
if (
	rows.length !== 2 * cases.length ||
	gradeById.size !== rows.length ||
	new Set(rows.map(({ case: id, arm }) => id + "/" + arm)).size !== rows.length
)
	throw Error("incomplete_pair_set");
for (const row of rows) {
	const grade = gradeById.get(row.blindId);
	if (
		grade?.checks.length !== 4 ||
		grade.checks.some((v) => typeof v !== "boolean")
	)
		throw Error("invalid_grade");
	if (
		row.calls.some(
			(call) => call.model != null && call.model !== registration.model,
		)
	)
		throw Error("unexpected_provider_model");
	row.score = grade.checks.filter(Boolean).length;
}
const total = (values) => values.reduce((sum, value) => sum + value, 0);
const median = (values) => {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2
		? sorted[middle]
		: (sorted[middle - 1] + sorted[middle]) / 2;
};
const aggregate = (arm) => {
	const records = rows.filter((row) => row.arm === arm);
	const calls = records.flatMap((row) => row.calls);
	const completed = records.filter((row) => row.status === "completed");
	const procedureRows = records.filter(
		(row) => cases.find((task) => task.id === row.case).procedureCheck,
	);
	return {
		completed: completed.length,
		attempted: records.length,
		quality: total(records.map((row) => row.score)),
		qualityMax: records.length * 4,
		procedureCompliance: procedureRows.filter(
			(row) => gradeById.get(row.blindId).procedure === true,
		).length,
		procedureCases: procedureRows.length,
		replyMedianMs: median(
			records.flatMap((row) => (row.replyMs == null ? [] : [row.replyMs])),
		),
		replySentenceOverruns: records.filter(
			(row) => row.replyStyle?.sentenceLimitExceeded,
		).length,
		completionMedianMs: median(completed.map((row) => row.completionMs)),
		calls: calls.length,
		inputTokens: total(
			calls.flatMap((call) =>
				call.inputTokens == null ? [] : [call.inputTokens],
			),
		),
		outputTokens: total(
			calls.flatMap((call) =>
				call.outputTokens == null ? [] : [call.outputTokens],
			),
		),
		reasoningTokens: calls.some((call) => call.reasoningTokens != null)
			? total(
					calls.flatMap((call) =>
						call.reasoningTokens == null ? [] : [call.reasoningTokens],
					),
				)
			: null,
		callsWithUsage: calls.filter(
			(call) => call.inputTokens != null && call.outputTokens != null,
		).length,
	};
};

const pairs = cases.map((task) => {
	const get = (arm) =>
		rows.find((row) => row.case === task.id && row.arm === arm);
	const current = get("current");
	const assisted = get("assisted");
	const fields = (row) => ({
		score: row.score,
		procedure: gradeById.get(row.blindId).procedure,
		replyMs: row.replyMs,
		completionMs: row.completionMs,
		status: row.status,
		calls: row.calls.length,
	});
	return {
		case: task.id,
		title: task.title,
		current: fields(current),
		assisted: fields(assisted),
		review: {
			wanted: task.useful.review,
			selected: !!assisted.requests?.review,
			started: assisted.calls.some((call) => call.lane === "evaluator"),
			result: assisted.review?.value?.status ?? assisted.review?.status ?? null,
			conditions: assisted.requests?.review?.conditionIds ?? [],
		},
		skill: {
			wanted: task.useful.skill,
			selected: !!assisted.requests?.skill,
			started: assisted.skill != null,
			calls: assisted.calls.filter((call) => call.lane === "skill-smith")
				.length,
			result: assisted.skill?.status ?? null,
			procedureReflected: gradeById.get(assisted.blindId).procedure,
			error: assisted.skill?.error,
			query: assisted.requests?.skill?.query ?? null,
		},
	};
});
const selectors = Object.fromEntries(
	["review", "skill"].map((kind) => [
		kind,
		{
			selectedOnUseful: pairs.filter((p) => p[kind].wanted && p[kind].selected)
				.length,
			useful: pairs.filter((p) => p[kind].wanted).length,
			usefulWithDecision: pairs.filter(
				(p) => p[kind].wanted && p.assisted.replyMs != null,
			).length,
			selectedOnOther: pairs.filter((p) => !p[kind].wanted && p[kind].selected)
				.length,
			other: pairs.filter((p) => !p[kind].wanted).length,
		},
	]),
);
const result = {
	current: aggregate("current"),
	assisted: aggregate("assisted"),
	selectors,
	pairs,
	commonCompleted: (() => {
		const completed = pairs.filter(
			(p) =>
				p.current.status === "completed" && p.assisted.status === "completed",
		);
		return {
			pairs: completed.length,
			qualityMax: completed.length * 4,
			currentQuality: total(completed.map((p) => p.current.score)),
			assistedQuality: total(completed.map((p) => p.assisted.score)),
		};
	})(),
	pairQuality: {
		better: pairs.filter((p) => p.assisted.score > p.current.score).length,
		equal: pairs.filter((p) => p.assisted.score === p.current.score).length,
		worse: pairs.filter((p) => p.assisted.score < p.current.score).length,
	},
};
await writeFile(
	join(dir, "summary.json"),
	JSON.stringify(result, null, 2) + "\n",
);
console.log(JSON.stringify(result, null, 2));
