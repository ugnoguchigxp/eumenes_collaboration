import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [directory] = Bun.argv.slice(2);
if (!directory) throw new Error("usage: score-hard.mjs <result directory>");

const clean = (cell) =>
	cell.replaceAll(/[`*\s]/g, "").replaceAll(/[→＞]/g, ">");
const allocation = (cell) =>
	cell.includes("=") ? cell.split("+").sort().join("+") : cell;

function readTable(body, ids) {
	const table = new Map();
	for (const line of body.split("\n")) {
		const cells = line
			.trim()
			.replace(/^\||\|$/g, "")
			.split(/[|\t]/)
			.map(clean);
		if (!ids.has(cells[0])) continue;
		// Repeated entries for an ID do not give the next operator a single verdict.
		table.set(cells[0], table.has(cells[0]) ? [] : cells.slice(1));
	}
	return table;
}

function grade(task, body) {
	const table = readTable(body, new Set(task.expected.map(([id]) => id)));
	return task.expected.map(([id, ...expected]) => {
		const observed = table.get(id) ?? [];
		const fields = expected.map((value, index) => {
			const actual = observed[index] ?? "";
			if (value.includes("=")) return allocation(value) === allocation(actual);
			if (value === "一致" || value === "要修正") {
				const label = actual.split(/[（(。]/, 1)[0];
				return (
					value ===
					(["不一致", "不一致・要修正"].includes(label) ? "要修正" : label)
				);
			}
			if (value === "-" && /^[—–－]$/.test(actual)) return true;
			return value === actual;
		});
		return { id, expected, observed, fields, correct: fields.every(Boolean) };
	});
}

const read = (name) => readFile(join(directory, name), "utf8");
const registration = JSON.parse(await read("registration.json"));
if (!["hard", "border"].includes(registration.suite))
	throw new Error("expected_scored_suite");
const snapshot = await read("cases.mjs");
if (
	createHash("sha256").update(snapshot).digest("hex") !==
	registration.hashes[`eval/proactive/luna/${registration.suite}-cases.mjs`]
)
	throw new Error("unexpected_case_snapshot");
const { cases } = await import(
	pathToFileURL(resolve(directory, "cases.mjs")).href
);
const blind = JSON.parse(await read("blind.json"));
const grades = blind.map(({ case: id, id: blindId, artifact }) => ({
	case: id,
	id: blindId,
	checks: grade(
		cases.find((task) => task.id === id),
		artifact?.body ?? "",
	),
}));
await writeFile(
	join(directory, "grades.json"),
	JSON.stringify(grades, null, 2) + "\n",
);
const gradesById = new Map(grades.map((value) => [value.id, value]));
const raw = (await read("raw.jsonl")).trim().split("\n").map(JSON.parse);
const expectedTrials = registration.cases.reduce(
	(sum, task) => sum + task.order.length * registration.repetitions,
	0,
);
if (
	raw.length !== expectedTrials ||
	gradesById.size !== expectedTrials ||
	new Set(raw.map((r) => [r.case, r.arm, r.repetition ?? 1].join("/"))).size !==
		expectedTrials ||
	raw.some((r) =>
		r.calls.some((c) => c.model != null && c.model !== registration.model),
	)
)
	throw new Error("unexpected_trial_set");

const trials = raw.map(
	({
		case: id,
		arm,
		repetition,
		blindId,
		calls,
		status,
		replyMs,
		completionMs,
		requests,
		review,
		skill,
	}) => {
		const record = gradesById.get(blindId);
		if (record?.case !== id) throw new Error("trial_grade_mismatch");
		const { checks } = record;
		const fields = checks.flatMap((check) => check.fields);
		return {
			case: id,
			arm,
			repetition: repetition ?? 1,
			status,
			score: checks.filter((check) => check.correct).length,
			max: checks.length,
			fields: fields.filter(Boolean).length,
			maxFields: fields.length,
			replyMs,
			completionMs,
			modelCalls: calls.length,
			inputTokens: calls.reduce((sum, c) => sum + (c.inputTokens ?? 0), 0),
			outputTokens: calls.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0),
			review: {
				selected: Boolean(requests?.review),
				result: review?.value?.status ?? review?.status ?? null,
			},
			skill: {
				selected: Boolean(requests?.skill),
				result: skill?.status ?? null,
			},
		};
	},
);
const total = (trials, key) =>
	trials.reduce((sum, trial) => sum + trial[key], 0);
const summary = Object.fromEntries(
	Object.keys(registration.maxCallsPerArm).map((arm) => {
		const selected = trials.filter((trial) => trial.arm === arm);
		return [
			arm,
			{
				completed: selected.filter((trial) => trial.status === "completed")
					.length,
				attempted: selected.length,
				score: total(selected, "score"),
				max: total(selected, "max"),
				fields: total(selected, "fields"),
				maxFields: total(selected, "maxFields"),
				modelCalls: total(selected, "modelCalls"),
				inputTokens: total(selected, "inputTokens"),
				outputTokens: total(selected, "outputTokens"),
				trials: selected,
			},
		];
	}),
);
await writeFile(
	join(directory, "summary.json"),
	JSON.stringify(summary, null, 2) + "\n",
);
console.log(JSON.stringify(summary, null, 2));
