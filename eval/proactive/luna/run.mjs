import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import { createTrialModel } from "../../../example/proactive/codex.mjs";
import {
	createServices,
	fixtureConnection,
} from "../../../example/proactive/services.mjs";
import { startTrial } from "../../../example/proactive/session.ts";

const [host, output, ...options] = Bun.argv.slice(2);
const hard = options.includes("--hard");
const currentOnly = options.includes("--current-only");
const isolateSupport = options.includes("--isolate-support");
const reviewArmsOnly = options.includes("--review-arms-only");
const repeated = options.find((option) => option.startsWith("--repetitions="));
const evaluationLimit = options.find((option) =>
	option.startsWith("--evaluator-timeout-ms="),
);
const repetitions = Number(repeated?.split("=")[1] ?? 1);
const perCallTimeoutMs = 60_000;
const evaluatorTimeoutMs = Number(
	evaluationLimit?.slice("--evaluator-timeout-ms=".length) ?? perCallTimeoutMs,
);
if (
	!host ||
	!output ||
	(isolateSupport && (!hard || currentOnly)) ||
	(reviewArmsOnly && (!hard || currentOnly || isolateSupport)) ||
	options.some(
		(option) =>
			![
				"--hard",
				"--current-only",
				"--isolate-support",
				"--review-arms-only",
				repeated,
				evaluationLimit,
			].includes(option),
	) ||
	!Number.isSafeInteger(repetitions) ||
	repetitions < 1 ||
	!Number.isSafeInteger(evaluatorTimeoutMs) ||
	evaluatorTimeoutMs < 1 ||
	evaluatorTimeoutMs > 120_000
)
	throw new Error(
		"usage: run.mjs <isolated host> <new result directory> [--hard] [--current-only | --isolate-support | --review-arms-only] [--repetitions=N] [--evaluator-timeout-ms=N]",
	);
const casesPath = hard ? "hard-cases.mjs" : "cases.mjs";
const { cases, procedures } = await import("./" + casesPath);
const model = "gpt-6-luna";
const supportArmLimits = {
	current: 2,
	"evaluator-only": 3,
	"skill-only": 3,
	assisted: 6,
};
const maxCallsPerArm = isolateSupport
	? supportArmLimits
	: reviewArmsOnly
		? { "evaluator-only": 3, assisted: 6 }
		: currentOnly
			? { current: 2 }
			: { current: 2, assisted: 6 };
const reviewArmTimeoutMs =
	2 * perCallTimeoutMs + Math.max(evaluatorTimeoutMs, perCallTimeoutMs);
await mkdir(output);
function armOrder(index, repetition) {
	if (currentOnly) return ["current"];
	if (isolateSupport || reviewArmsOnly) {
		const arms = Object.keys(supportArmLimits);
		const offset = index % arms.length;
		const rotated = arms.slice(offset).concat(arms.slice(0, offset));
		if (repetition % 2 === 0) rotated.reverse();
		return rotated.filter((arm) => Object.hasOwn(maxCallsPerArm, arm));
	}
	return index % 2 === 0 ? ["current", "assisted"] : ["assisted", "current"];
}
const schedule = cases.map(({ id }, index) => ({
	id,
	order: armOrder(index, 1),
	...(isolateSupport || reviewArmsOnly
		? {
				orders: Array.from({ length: repetitions }, (_, offset) =>
					armOrder(index, offset + 1),
				),
			}
		: {}),
}));
const inputs = [
	"eval/proactive/luna/" + casesPath,
	"eval/proactive/luna/run.mjs",
	"example/proactive/codex.mjs",
	"example/proactive/services.mjs",
	"example/proactive/session.ts",
];
const hashes = Object.fromEntries(
	await Promise.all(
		inputs.map(async (path) => [
			path,
			createHash("sha256")
				.update(await readFile(path))
				.digest("hex"),
		]),
	),
);
if (hard) {
	await writeFile(join(output, "cases.mjs"), await readFile(inputs[0]), {
		flag: "wx",
	});
}
await writeFile(
	join(output, "registration.json"),
	JSON.stringify(
		{
			model,
			reasoning: "low",
			route: "codex-subscription",
			cases: schedule,
			repetitions,
			concurrentPairs: 2,
			maxCallsPerArm,
			maxCallsTotal:
				cases.length *
				repetitions *
				Object.values(maxCallsPerArm).reduce((sum, limit) => sum + limit, 0),
			armTimeoutMs: currentOnly ? 3 * perCallTimeoutMs : reviewArmTimeoutMs,
			perCallTimeoutMs,
			evaluatorTimeoutMs,
			artifactCriteriaPerCase: hard ? cases[0].expected.length : 4,
			...(hard ? { suite: "hard" } : {}),
			hashes,
		},
		null,
		2,
	) + "\n",
	{ flag: "wx" },
);

async function runArm(task, arm, repetition) {
	const calls = [];
	const enableReview = arm === "assisted" || arm === "evaluator-only";
	const enableSkill = arm === "assisted" || arm === "skill-only";
	const signal = AbortSignal.timeout(
		enableReview ? reviewArmTimeoutMs : 3 * perCallTimeoutMs,
	);
	const row = {
		case: task.id,
		arm,
		...(repetitions > 1 ? { repetition } : {}),
		blindId: randomUUID().slice(0, 12),
		calls,
	};
	const complete = await createTrialModel(
		host,
		model,
		calls,
		maxCallsPerArm[arm],
		signal,
	);
	const connection =
		enableReview || enableSkill
			? await fixtureConnection(enableSkill ? procedures : [])
			: null;
	const started = performance.now();
	try {
		const available = connection
			? await createServices(connection, complete, { evaluatorTimeoutMs })
			: {};
		const services = {
			...(enableReview ? { review: available.review } : {}),
			...(enableSkill
				? { skill: available.skill, skillCatalog: available.skillCatalog }
				: {}),
		};
		let isReply = true;
		const trial = await startTrial(
			task.input,
			{
				infer(request) {
					const lane = isReply ? "reply" : "artifact";
					isReply = false;
					return complete(lane, request);
				},
			},
			services,
			signal,
			true,
		);
		Object.assign(row, {
			reply: trial.reply,
			replyStyle: trial.replyStyle,
			replyMs: Math.round(performance.now() - started),
			requests: trial.requests,
		});
		console.log(
			JSON.stringify({
				case: task.id,
				repetition,
				arm,
				phase: "reply",
				ms: row.replyMs,
				review: !!row.requests.review,
				skill: !!row.requests.skill,
			}),
		);
		const background = await trial.runBackground();
		Object.assign(row, {
			review: background.review,
			skill: background.skill,
			artifact: background.artifact,
			completionMs: Math.round(performance.now() - started),
			status: background.artifact?.status === "ok" ? "completed" : "failed",
		});
	} catch (error) {
		Object.assign(row, {
			status: "failed",
			elapsedMs: Math.round(performance.now() - started),
			error: error.message,
		});
	} finally {
		await connection?.close();
	}
	return row;
}

const rows = [];
let cursor = 0;
async function worker() {
	while (cursor < cases.length * repetitions) {
		const job = cursor++;
		const index = job % cases.length;
		const repetition = Math.floor(job / cases.length) + 1;
		for (const arm of armOrder(index, repetition)) {
			const row = await runArm(cases[index], arm, repetition);
			rows.push(row);
			await appendFile(join(output, "raw.jsonl"), JSON.stringify(row) + "\n");
			console.log(
				JSON.stringify({
					case: row.case,
					repetition,
					arm,
					phase: row.status,
					ms: row.completionMs,
					calls: row.calls.length,
				}),
			);
		}
	}
}
await Promise.all([worker(), worker()]);
const blind = rows
	.map((row) => ({
		case: row.case,
		id: row.blindId,
		artifact: row.artifact?.value ?? null,
	}))
	.sort((a, b) => a.case.localeCompare(b.case) || a.id.localeCompare(b.id));
await writeFile(
	join(output, "blind.json"),
	JSON.stringify(blind, null, 2) + "\n",
	{ flag: "wx" },
);
