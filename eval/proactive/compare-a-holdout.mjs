import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";
import { createTrialModel } from "../../example/proactive/codex.mjs";
import {
	assessTrial,
	openingContent,
	reference,
	replayOpening,
} from "./compare-supplement.mjs";
import { checkFreshEvaluation, checkInventory } from "./index.ts";
import { captureCase } from "./supplement-trial.mjs";

const sha = (data) => createHash("sha256").update(data).digest("hex");
const digest = async (path) => sha(await readFile(path));
const local = (file) => new URL(file, import.meta.url);
const atHost = (host, file) => pathToFileURL(resolve(host, file)).href;
const packagePath = "node_modules/eumenes-collaboration";
const protocol = JSON.parse(await readFile(local("./protocol.json"), "utf8"));
const { positionals, values } = parseArgs({
	args: Bun.argv.slice(2),
	allowPositionals: true,
	options: { fixed: { type: "boolean" }, tasks: { type: "string" } },
});
const [beforePath, afterPath, archivePath, output] = positionals;
if (
	!beforePath ||
	!afterPath ||
	!archivePath ||
	!output ||
	positionals.length !== 4
)
	throw new Error(
		"usage: bun eval/proactive/compare-a-holdout.mjs <before-host> <after-host> <opening-archive.jsonl.gz> <new-output.jsonl> [--fixed] [--tasks <fresh-tasks.json>]",
	);
const fixed = values.fixed === true;
const original = checkInventory(
	JSON.parse(await readFile(local("./development.json"), "utf8")),
	JSON.parse(await readFile(local("./holdout.json"), "utf8")),
);
const tasksPath = values.tasks ?? local("./holdout.json");
const tasks = values.tasks
	? checkFreshEvaluation(JSON.parse(await readFile(tasksPath, "utf8")), [
			...original.development,
			...original.holdout,
		])
	: original.holdout;
const archive = await readFile(archivePath);
const openings = new Map(
	gunzipSync(archive)
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line))
		.filter((row) => row.taskId && row.turns[0]?.work?.definition)
		.map(({ taskId, repetition, turns }) => [
			`${taskId}:${repetition}`,
			turns[0],
		]),
);
const parallelPairs = 6;
const maxCalls = protocol.maxModelCallsByMode.A;
const maxDurationMs = 1_500_000;
const signal = AbortSignal.timeout(maxDurationMs);
const model = protocol.baseline.model;
const variants = await Promise.all(
	[
		["before", beforePath],
		["after", afterPath],
	].map(async ([name, host]) => {
		const catalogFile = resolve(host, packagePath, ".s11tnext/catalog.json");
		const catalogBytes = await readFile(catalogFile);
		const { collaborationInstructions } = await import(
			atHost(host, `${packagePath}/src/agent/instructions.ts`)
		);
		const { harness } = await import(
			atHost(host, "api/application/toolchain/toolchain.fixture.ts")
		);
		const calls = [];
		return {
			name,
			rules: collaborationInstructions.rules,
			catalog: JSON.parse(catalogBytes),
			catalogSha256: sha(catalogBytes),
			lockSha256: await digest(resolve(host, "bun.lock")),
			fixtureSha256: await digest(
				resolve(host, "api/application/toolchain/toolchain.fixture.ts"),
			),
			harness,
			calls,
			complete: fixed
				? async (_lane, request) => ({
						output: {
							action: "reply",
							text: "承知しました。",
							stateUpdate: reference(request.messages, "STATE_UPDATE_BASE"),
						},
					})
				: await createTrialModel(host, model, calls, maxCalls, signal),
		};
	}),
);
const [before, after] = variants;
function otherCatalogEntries({
	catalogDigest: _catalogDigest,
	contexts,
	...catalog
}) {
	const { ["collaboration.rules"]: _rules, ...otherContexts } = contexts;
	return { ...catalog, contexts: otherContexts };
}
if (
	before.rules === after.rules ||
	before.lockSha256 !== after.lockSha256 ||
	before.fixtureSha256 !== after.fixtureSha256 ||
	after.catalogSha256 !==
		(await digest(local("../../.s11tnext/catalog.json"))) ||
	!isDeepStrictEqual(
		otherCatalogEntries(before.catalog),
		otherCatalogEntries(after.catalog),
	)
)
	throw new Error("holdout_variant_environment_mismatch");

const jobs = tasks.flatMap((task, index) =>
	Array.from({ length: fixed ? 1 : protocol.repetitions }, (_, offset) => {
		const repetition = offset + 1;
		const openingKey = openings.has(`${task.id}:${repetition}`)
			? `${task.id}:${repetition}`
			: `${task.id}:${protocol.repetitions}`;
		const opening = openings.get(openingKey);
		if (!opening || opening.text !== task.opening)
			throw new Error(`holdout_opening_missing:${task.id}:${repetition}`);
		return {
			task,
			repetition,
			openingKey,
			opening,
			reverse: (index + offset) % 2 === 1,
		};
	}),
);
const registration = {
	kind: "registration",
	status: fixed ? "fixed_preflight" : "registered_holdout",
	split: values.tasks ? "fresh-holdout" : "holdout",
	model,
	reasoningEffort: protocol.baseline.reasoningEffort,
	route: protocol.baseline.modelRoute,
	hostCommit: protocol.baseline.eumenesBaseCommit,
	hostArchiveSha256: protocol.baseline.productSnapshotSha256,
	binding: protocol.baseline.binding,
	fixtureAgency: "default F settings; toolchain fixture with fixed UI routing",
	holdoutSha256: await digest(tasksPath),
	protocolSha256: await digest(local("./protocol.json")),
	openingArchiveSha256: sha(archive),
	runnerSha256: await digest(import.meta.path),
	judgeRunnerSha256: await digest(local("./compare-supplement.mjs")),
	fixtureRunnerSha256: await digest(local("./supplement-trial.mjs")),
	modelRunnerSha256: await digest(local("../../example/proactive/codex.mjs")),
	observationRunnerSha256: await digest(local("./observation.ts")),
	variants: variants.map(
		({ name, rules, catalogSha256, lockSha256, fixtureSha256 }) => ({
			name,
			rulesSha256: sha(rules),
			catalogSha256,
			lockSha256,
			fixtureSha256,
		}),
	),
	plannedTrials: jobs.length * variants.length,
	repetitions: fixed ? 1 : protocol.repetitions,
	maxModelCallsPerVariant: maxCalls,
	maxExtraApiUsd: protocol.liveBudgetUsd,
	maxDurationMs,
	parallelPairs,
	observationWindowMs: protocol.observationWindowMs,
	openings: jobs.map(({ task, repetition, openingKey }) => ({
		taskId: task.id,
		repetition,
		openingKey,
	})),
	assessment:
		"Same mode-blind user role and one prewritten follow-up. Audit first replies and protected work separately.",
	adoption: {
		paired:
			"Preparation/blockage improvements must outnumber regressions. Maintain main outcome and conditions. No new regression in any wait/quiet repetition.",
		initialAlternative: values.tasks
			? "In blocked current requests count an independent practical alternative that reaches the current result plus its own check or implementation conditions in the first ordinary reply. Audit unwanted alternatives outside that scope."
			: "In blockage cases count a concrete feasible alternative or interim handling plus an actionable confirmation condition in the first ordinary reply. Grade alternatives and conditions independently.",
		followUpsAndProposals:
			"Require a decrease in at least one and no increase in the other. Keep the registered zero tolerance for unnecessary proposals on protected cases.",
		latency: protocol.limits,
	},
};
const append = (value) => appendFileSync(output, JSON.stringify(value) + "\n");
await writeFile(output, JSON.stringify(registration) + "\n", {
	flag: "wx",
	mode: 0o600,
});

async function runTrial({ task, repetition, opening, openingKey }, variant) {
	const metadata = {
		taskId: task.id,
		repetition,
		variant: variant.name,
		openingKey,
	};
	let record;
	try {
		record = await captureCase(
			task,
			variant.harness,
			async (lane, request) => {
				const system = request.messages[0]?.content;
				if (
					!system?.includes(variant.rules) ||
					(variant === before && system.includes(after.rules))
				)
					throw new Error("holdout_rules_not_loaded");
				if (lane === "opening")
					return { output: replayOpening(task, opening, request.messages) };
				return variant.complete(lane, request);
			},
			{
				mode: "A",
				repetition,
				checkOpening(turn) {
					if (!isDeepStrictEqual(openingContent(turn), openingContent(opening)))
						throw new Error("holdout_opening_not_identical");
				},
				assess: fixed
					? async ({ followUp }) => {
							const response = task.followUp ? await followUp() : null;
							if (response && response.status !== "ok")
								throw new Error("holdout_fixed_follow_up_failed");
							return { followUps: response ? 1 : 0 };
						}
					: (context) => assessTrial(task, variant.complete, context),
			},
		);
	} catch (error) {
		record = {
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	append({ ...record, ...metadata });
	console.log(
		JSON.stringify({
			...metadata,
			status: record.status,
			followUps: record.assessment?.followUps,
		}),
	);
}

let next = 0;
await Promise.all(
	Array.from({ length: parallelPairs }, async () => {
		while (next < jobs.length) {
			const job = jobs[next++];
			const ordered = job.reverse ? [after, before] : variants;
			await Promise.all(ordered.map((variant) => runTrial(job, variant)));
		}
	}),
);
append({
	kind: "usage",
	variants: variants.map(({ name, calls }) => ({ name, calls })),
});
