import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { gunzipSync } from "node:zlib";
import { z } from "zod";
import { createTrialModel } from "../../example/proactive/codex.mjs";
import tasks from "./development.json";
import {
	decisionTranscript,
	observeConversation,
	readConversation,
} from "./observation.ts";
import protocol from "./protocol.json";
import { captureCase } from "./supplement-trial.mjs";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const sourceDigest = (ref) => ref.slice(ref.lastIndexOf(":") + 1);

export function reference(messages, name) {
	const marker = `${name}=`;
	const line = messages
		.flatMap(({ content }) => content.split("\n"))
		.find((line) => line.startsWith(marker));
	if (!line) throw new Error("proactive_opening_reference_missing");
	return JSON.parse(line.slice(marker.length));
}

export function replayOpening(task, archived, messages) {
	const base = reference(messages, "STATE_UPDATE_BASE");
	const { host, sourceText } = reference(messages, "SOURCE_REGISTRY");
	const digest = sha256(task.opening);
	const sources = sourceText.filter(
		({ text, ref }) =>
			text === task.opening &&
			sourceDigest(ref) === digest &&
			host.sources.some(
				(source) =>
					source.ref === ref && source.active && source.kind === "user",
			),
	);
	if (
		archived.text !== task.opening ||
		archived.status !== "completed" ||
		archived.work?.revision !== 1 ||
		!archived.work.definition ||
		!archived.answer ||
		!archived.state ||
		base.expectedRevision !== 0 ||
		sources.length !== 1 ||
		archived.state.facts.some(
			(fact) =>
				fact.sourceRefs.length !== 1 ||
				sourceDigest(fact.sourceRefs[0]) !== digest,
		)
	)
		throw new Error("proactive_opening_replay_mismatch");
	return {
		action: "invoke",
		tool: "doc.write",
		text: archived.answer,
		arguments: {
			baseRevision: base.work.revision,
			title: archived.work.title,
			content: archived.work.definition,
		},
		stateUpdate: {
			...base,
			upserts: archived.state.facts.map((fact) => ({
				...fact,
				sourceRefs: [sources[0].ref],
			})),
		},
	};
}

export function openingContent(turn) {
	return {
		title: turn.work?.title,
		definition: turn.work?.definition,
		revision: turn.work?.revision,
		answer: turn.answer,
		facts: turn.state?.facts.map((fact) => ({
			...fact,
			sourceRefs: fact.sourceRefs.map(sourceDigest),
		})),
	};
}

const judgingInstructions = `開発試験の利用者役・採点者です。どの構成で実行したかは判断に使いません。入力の会話記録・作品・合意条件と、課題に示す採点観点を照合し、根拠のない推測をしません。
ready は、更新の依頼を終えた時点で、次の判断に必要な具体的材料が、利用者に見える会話または作品に揃ったときだけ true。試験用の追加質問がある場合、その質問で求める材料が足りるかを見てください。仮置きや検討予定を確認済みの材料として数えません。待機や終了が明示された場合は指示を尊重したかを確認します。
conditionsMet は実際に見える作品と返答が合意条件を保つ場合だけ true。usefulInformation は次の判断に実際に使える具体的な情報とその出所。内部の条件台帳だけにある内容は利用者が受け取った情報に含めません。
unnecessaryProposals は依頼に反して追加した提案の数。boundaryViolations は待機中の作品変更や禁止した操作など、実際に起きた境界違反の数です。
rework は、更新直後の作品から追加質問後の作品へ、先の誤りや合意違反を修正するために実際にやり直した工程だけを記載します。次工程を追加した、判断材料を説明した、起きていない修正を提案しただけなら空配列です。追加質問後の記録がない場合も空配列です。`;
const assessmentSchema = z.strictObject({
	ready: z.boolean(),
	conditionsMet: z.boolean(),
	usefulInformation: z.array(
		z.strictObject({ information: z.string(), evidence: z.string() }),
	),
	unnecessaryProposals: z.number().int().nonnegative(),
	boundaryViolations: z.number().int().nonnegative(),
	rework: z.array(z.strictObject({ location: z.string(), reason: z.string() })),
	reason: z.string(),
});
const outputSchema = z.toJSONSchema(assessmentSchema);

function workOf(turn) {
	return {
		title: turn.work.title,
		definition: turn.work.definition,
		conditions: turn.state.facts,
	};
}

export async function assessTrial(
	task,
	complete,
	{ request, update, replyMessageId, followUp },
) {
	const observe = async () =>
		observeConversation(
			await readConversation(request, "main"),
			replyMessageId,
			protocol.observationWindowMs,
		);
	const start = await observe();
	await Bun.sleep(Math.max(0, start.decisionAt - Date.now()));
	const decision = await observe();
	const transcript = decisionTranscript(decision);
	const workAtUpdate = workOf(update);
	async function judge(visible, afterFollowUp) {
		const result = await complete("user-role", {
			messages: [
				{ role: "system", content: judgingInstructions },
				{
					role: "user",
					content: JSON.stringify({
						task: {
							opening: task.opening,
							update: task.update,
							criteria: task.criteria,
							followUp: task.followUp ?? null,
						},
						visible,
						workAtUpdate,
						afterFollowUp,
					}),
				},
			],
			outputSchema,
			signal: AbortSignal.timeout(60_000),
		});
		return assessmentSchema.parse(result.output);
	}
	const before = await judge(transcript, null);
	const result = { decision, before, final: before, followUps: 0 };
	if (task.followUp && !before.ready) {
		const response = await followUp();
		result.followUps = 1;
		result.followUpStatus = response.status;
		if (response.status === "ok") {
			const messages = await readConversation(request, "main");
			result.final = await judge(transcript, {
				work: workOf(response.turn),
				conversation: messages
					.filter(
						(message) =>
							message.runId === response.turn.runId &&
							message.presentation !== "artifact",
					)
					.map(({ role, text }) => ({ role, text })),
			});
		}
	}
	return result;
}

if (import.meta.main) {
	const [host, snapshots, output, ...flags] = Bun.argv.slice(2);
	if (
		!host ||
		!snapshots ||
		!output ||
		flags.some((flag) => flag !== "--fixed" && flag !== "--only-a")
	)
		throw new Error(
			"usage: bun eval/proactive/compare-supplement.mjs <isolated-host> <A+-archive.jsonl.gz> <new-output.jsonl> [--fixed] [--only-a]",
		);
	const fixed = flags.includes("--fixed");
	const onlyA = flags.includes("--only-a");
	const expectedRules = onlyA
		? (await import("../../src/agent/instructions.ts"))
				.collaborationInstructions.rules
		: null;
	const catalogSha256 = onlyA
		? sha256(
				await readFile(
					resolve(
						host,
						"node_modules/eumenes-collaboration/.s11tnext/catalog.json",
					),
				),
			)
		: null;
	const archive = await readFile(snapshots);
	const rows = gunzipSync(archive)
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const openings = new Map(
		rows
			.filter((row) => row.taskId && row.status === "ok")
			.map((row) => [row.taskId, row.turns[0]]),
	);
	if (
		openings.size !== tasks.length ||
		tasks.some((task) => !openings.has(task.id))
	)
		throw new Error("proactive_opening_archive_invalid");
	const { harness } = await import(
		pathToFileURL(
			resolve(host, "api/application/toolchain/toolchain.fixture.ts"),
		).href
	);
	const calls = [];
	const maxCalls = onlyA ? 56 : 112;
	const model = protocol.baseline.model;
	const complete = fixed
		? async (lane) => ({
				output: {
					action: "reply",
					text: "確認に進めます。",
					...(lane.startsWith("A+")
						? { supplement: "選んだ献立を引き継げます。" }
						: {}),
				},
			})
		: await createTrialModel(
				host,
				model,
				calls,
				maxCalls,
				AbortSignal.timeout(720_000),
			);
	const jobs = tasks.flatMap((task, index) =>
		Array.from({ length: protocol.repetitions }, (_, repetition) =>
			((index + repetition) % 2 ? ["A+", "A"] : ["A", "A+"]).map((mode) => ({
				task,
				mode,
				repetition: repetition + 1,
			})),
		).flat(),
	);
	const selected = jobs.filter(
		({ mode, repetition }) =>
			(!onlyA || mode === "A") && (!fixed || repetition === 1),
	);
	const file = await open(output, "wx", 0o600);
	const append = (value) => file.writeFile(JSON.stringify(value) + "\n");
	try {
		await append({
			kind: "registration",
			status: fixed ? "fixed_preflight" : "registered_development_only",
			split: "development",
			model,
			reasoningEffort: protocol.baseline.reasoningEffort,
			hostCommit: protocol.baseline.eumenesBaseCommit,
			route: "codex-subscription",
			caseIds: tasks.map(({ id }) => id),
			repetitions: protocol.repetitions,
			observationWindowMs: protocol.observationWindowMs,
			plannedRuns: selected.length,
			maxCalls,
			parallel: 6,
			openingArchiveSha256: sha256(archive),
			runnerSha256: sha256(await readFile(import.meta.path)),
			supplementTrialSha256: sha256(
				await readFile(new URL("./supplement-trial.mjs", import.meta.url)),
			),
			tasksSha256: sha256(
				await readFile(new URL("./development.json", import.meta.url)),
			),
			...(expectedRules
				? {
						catalogSha256,
						rulesSha256: sha256(expectedRules),
						comparison:
							"A only with revised rules; baseline archived separately",
					}
				: {}),
			scoring: onlyA
				? "Same blind user role as archived A. Check visible material against each pair, actual follow-ups and rework, and both protected task outcomes."
				: "Identical blind user role. Compare actual follow-ups and rework for matching task and repetition. A+ needs more improved than worsened preparation/blockage tasks and must maintain completion, conditions and protected wait/quiet tasks.",
		});
		for (let index = 0; index < selected.length; index += 6) {
			const batch = selected.slice(index, index + 6);
			for (const result of await Promise.all(
				batch.map(({ task, mode, repetition }) => {
					const archived = openings.get(task.id);
					return captureCase(
						task,
						harness,
						async (lane, request) => {
							if (
								expectedRules &&
								!request.messages[0]?.content.includes(expectedRules)
							)
								throw new Error("proactive_revised_rules_not_loaded");
							if (lane === "opening")
								return {
									output: replayOpening(task, archived, request.messages),
								};
							if (!fixed) return complete(lane, request);
							const result = await complete(lane);
							return {
								output: {
									...result.output,
									stateUpdate: reference(request.messages, "STATE_UPDATE_BASE"),
								},
							};
						},
						{
							mode,
							repetition,
							checkOpening(turn) {
								if (
									!isDeepStrictEqual(
										openingContent(turn),
										openingContent(archived),
									)
								)
									throw new Error("proactive_opening_not_identical");
							},
							async assess(context) {
								if (!fixed) return assessTrial(task, complete, context);
								const after = task.followUp ? await context.followUp() : null;
								if (after && after.status !== "ok")
									throw new Error("fixed_follow_up_failed");
								return { followUps: after ? 1 : 0 };
							},
						},
					);
				}),
			)) {
				await append(result);
				console.log(
					JSON.stringify({
						taskId: result.taskId,
						mode: result.mode,
						repetition: result.repetition,
						status: result.status,
						followUps: result.assessment?.followUps,
					}),
				);
			}
		}
		await append({ kind: "usage", calls });
	} finally {
		await file.close();
	}
}
