import { createHash } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createTrialModel } from "../../example/proactive/codex.mjs";
import tasks from "./development.json";
import { readConversation } from "./observation.ts";

export const supplementLimit = 300;
const instruction = `通常の応答と操作の判断は従来どおりです。reply、または通常の返答 text を伴う invoke のときだけ、同じ出力の supplement に、次の制作判断に役立つ一手とその具体的な根拠を一件、${supplementLimit}字以内で書けます。通常の返答で伝えた内容の繰り返しは省きます。待機・終了を求められたとき、新しい材料がないとき、ほかの行動を選ぶときは null です。入力内で確かめられた事実を使い、未確定の条件や操作の可否は断定しません。`;

const schemaMarker = "\nOUTPUT_SCHEMA=";

function extendSchema(schema) {
	if (
		!schema?.properties?.action ||
		Object.hasOwn(schema.properties, "supplement")
	)
		throw new Error("supplement_trial_contract_unavailable");
	return {
		...schema,
		properties: {
			...schema.properties,
			supplement: { type: ["string", "null"], maxLength: supplementLimit },
		},
		required: [...(schema.required ?? []), "supplement"],
	};
}

export function supplementRequest(messages, schema) {
	const [system, ...rest] = messages;
	if (system?.role !== "system")
		throw new Error("supplement_trial_contract_unavailable");
	const marker = system.content.lastIndexOf(schemaMarker);
	const rendered =
		marker < 0
			? undefined
			: extendSchema(
					JSON.parse(system.content.slice(marker + schemaMarker.length)),
				);
	if (!schema && !rendered)
		throw new Error("supplement_trial_contract_unavailable");
	const body = marker < 0 ? system.content : system.content.slice(0, marker);
	const content =
		body +
		"\n" +
		instruction +
		(rendered ? schemaMarker + JSON.stringify(rendered) : "");
	return {
		messages: [{ ...system, content }, ...rest],
		...(schema ? { outputSchema: extendSchema(schema) } : {}),
	};
}

export function splitSupplement(output) {
	const { supplement, ...action } = output;
	const maySupplement =
		(action.action === "reply" || action.action === "invoke") &&
		typeof action.text === "string" &&
		Boolean(action.text.trim());
	const valid =
		supplement === null ||
		(maySupplement &&
			typeof supplement === "string" &&
			supplement.trim().length > 0 &&
			supplement.trim().length <= supplementLimit);
	return {
		action,
		valid,
		supplement: valid ? (supplement?.trim() ?? null) : null,
	};
}

export async function captureCase(task, harness, complete, options = {}) {
	const { mode = "A+", repetition = 1, checkOpening, assess } = options;
	const attempts = [];
	const turns = [];
	let phase = "opening";
	const fixture = await harness({
		uiCompositions: true,
		webResearch: false,
		routeTool: "ui_create",
		settingsEnv: {},
		async specialist(messages, signal, options) {
			const withSupplement = mode === "A+" && phase !== "opening";
			const input = withSupplement
				? supplementRequest(messages, options?.jsonSchema)
				: { messages, outputSchema: options?.jsonSchema };
			const lane = phase === "opening" ? phase : `${mode}-${phase}`;
			const result = await complete(lane, {
				...input,
				signal: signal ?? AbortSignal.timeout(90_000),
				timeoutMs: 90_000,
			});
			if (!withSupplement) return JSON.stringify(result.output);
			const resultWithSupplement = splitSupplement(result.output);
			attempts.push({
				action: resultWithSupplement.action.action,
				text: resultWithSupplement.action.text,
				supplement: resultWithSupplement.supplement,
				valid: resultWithSupplement.valid,
			});
			return JSON.stringify(resultWithSupplement.action);
		},
	});
	const record = {
		taskId: task.id,
		mode,
		repetition,
		turns,
		attempts,
	};
	try {
		async function send(text) {
			const start = performance.now();
			const response = await fixture.request("/api/runs", {
				requestId: crypto.randomUUID(),
				conversationId: "main",
				text,
			});
			if (response.status !== 202)
				throw new Error(`run_http_${response.status}`);
			const { id: runId } = await response.json();
			const run = await fixture.dialogue.waitForTerminal(runId, {
				timeoutMs: 120_000,
			});
			const elapsedMs = Math.round(performance.now() - start);
			const session = fixture.dialogue.specialistSession("main");
			const work =
				session &&
				(await fixture.request(
					"/api/toolchain-artifacts/artifact:ui.studio@4/sources/ui-studio",
				));
			const state =
				session &&
				(await fixture.request(
					`/api/specialist-sessions/${session.id}/collaboration-state`,
				));
			const turn = {
				text,
				runId,
				elapsedMs,
				status: run?.status ?? "timeout",
				error: run?.error ?? null,
				answer: fixture.dialogue.answerText(runId),
				session,
				work: work?.ok ? (await work.json()).data.work : null,
				state: state?.ok ? (await state.json()).state : null,
			};
			turns.push(turn);
			return turn;
		}
		async function deliver(turn, attempt) {
			if (
				turn.status !== "completed" ||
				!turn.work?.definition ||
				!turn.state ||
				!turn.answer
			)
				return { status: "reply_unconfirmed" };
			if (
				mode === "A+" &&
				(!attempt?.valid ||
					attempt.text?.trim() !== turn.answer.trim() ||
					!["reply", "invoke"].includes(attempt.action))
			)
				return { status: "supplement_unconfirmed" };

			const messages = await readConversation(fixture.request, "main");
			const reply = messages.findLast(
				(message) =>
					message.role === "assistant" &&
					message.runId === turn.runId &&
					message.text === turn.answer &&
					message.presentation !== "artifact",
			);
			if (!reply) return { status: "supplement_reply_not_visible" };
			let supplementMessage = null;
			if (attempt?.supplement) {
				const id = `proactive-supplement:${turn.runId}`;
				await fixture.conversation.append({
					id,
					conversationId: "main",
					role: "assistant",
					runId: turn.runId,
					text: attempt.supplement,
					createdAt: new Date().toISOString(),
				});
				supplementMessage =
					(await readConversation(fixture.request, "main")).find(
						(message) => message.id === id,
					) ?? null;
				if (supplementMessage?.text !== attempt.supplement)
					return { status: "supplement_not_visible" };
			}
			return { status: "ok", replyMessageId: reply.id, supplementMessage };
		}
		const opening = await send(task.opening);
		if (opening.status !== "completed" || !opening.work?.definition)
			return { ...record, status: "opening_unavailable" };
		checkOpening?.(opening);
		phase = "update";
		const update = await send(task.update);
		const delivery = await deliver(update, attempts.at(-1));
		if (delivery.status !== "ok" || !assess) return { ...record, ...delivery };
		const assessment = await assess({
			request: fixture.request,
			update,
			replyMessageId: delivery.replyMessageId,
			async followUp() {
				if (phase !== "update" || !task.followUp)
					throw new Error("proactive_follow_up_unavailable");
				phase = "follow-up";
				const previousAttempts = attempts.length;
				const turn = await send(task.followUp);
				const result = await deliver(
					turn,
					attempts.length > previousAttempts ? attempts.at(-1) : undefined,
				);
				return { turn, ...result };
			},
		});
		return { ...record, ...delivery, assessment };
	} catch (error) {
		return {
			...record,
			status: "failed",
			error: error instanceof Error ? error.message : String(error),
		};
	} finally {
		await fixture.close();
	}
}

if (import.meta.main) {
	const [host, output] = Bun.argv.slice(2);
	if (!host || !output)
		throw new Error(
			"usage: bun eval/proactive/supplement-trial.mjs <isolated-host> <new-output.jsonl>",
		);
	const model = "gpt-6.1-sol";
	const calls = [];
	const maxCalls = 48;
	const complete = await createTrialModel(
		host,
		model,
		calls,
		maxCalls,
		AbortSignal.timeout(480_000),
	);
	const { harness } = await import(
		pathToFileURL(
			resolve(host, "api/application/toolchain/toolchain.fixture.ts"),
		).href
	);
	const hash = async (path) =>
		createHash("sha256")
			.update(await readFile(path))
			.digest("hex");
	const file = await open(output, "wx", 0o600);
	const append = (row) => file.writeFile(JSON.stringify(row) + "\n");
	try {
		await append({
			kind: "registration",
			split: "development",
			mode: "A+",
			model,
			reasoningEffort: "low",
			route: "codex-subscription",
			maxCalls,
			parallel: 2,
			supplementLimit,
			caseIds: tasks.map(({ id }) => id),
			runnerSha256: await hash(import.meta.path),
			developmentSha256: await hash(
				new URL("./development.json", import.meta.url),
			),
		});
		for (let index = 0; index < tasks.length; index += 2) {
			for (const result of await Promise.all(
				tasks
					.slice(index, index + 2)
					.map((task) => captureCase(task, harness, complete)),
			)) {
				await append(result);
				console.log(
					JSON.stringify({ taskId: result.taskId, status: result.status }),
				);
			}
		}
		await append({ kind: "usage", calls });
	} finally {
		await file.close();
	}
}
