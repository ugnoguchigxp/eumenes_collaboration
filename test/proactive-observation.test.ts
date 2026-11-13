import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import development from "../eval/proactive/development.json";
import holdout from "../eval/proactive/holdout.json";
import { checkInventory, summarizeRuns } from "../eval/proactive/index.ts";
import {
	type ConversationMessage,
	decisionTranscript,
	observeConversation,
	readConversation,
} from "../eval/proactive/observation.ts";

const origin = Date.parse("2026-11-12T09:00:00Z");
const windowMs = 30_000;
const guidance =
	"確認画面には選んだ献立と数量を引き継げます。受取場所は未定です。";
function message(
	id: string,
	offsetMs: number,
	fields: Partial<ConversationMessage> = {},
): ConversationMessage {
	return {
		id,
		conversationId: "main",
		role: "assistant",
		text: id,
		createdAt: new Date(origin + offsetMs).toISOString(),
		runId: null,
		...fields,
	};
}
const updateReply = message("update", 0, { runId: "ordinary-run" });

test("the decision transcript includes committed standalone text in the window and keeps late text separate", () => {
	const observation = observeConversation(
		[
			updateReply,
			message("prepared", 1000, { text: guidance }),
			message("artifact-only", 2000, { presentation: "artifact" }),
			message("at-cutoff", 30_000),
			message("follow-up-answer", 33_000, { runId: "follow-up-run" }),
		],
		updateReply.id,
		windowMs,
	);
	expect(decisionTranscript(observation)).toEqual([
		{ order: 0, role: "assistant", text: "update", offsetMs: 0 },
		{ order: 1, role: "assistant", text: guidance, offsetMs: 1000 },
	]);
	expect(observation.laterStandalone.map(({ id }) => id)).toEqual([
		"at-cutoff",
	]);
});

test("a new user message ends observation in conversation order even at the same timestamp", () => {
	const observation = observeConversation(
		[
			updateReply,
			message("before-user", 500),
			message("new-user", 500, { role: "user" }),
			message("after-user", 500),
		],
		updateReply.id,
		windowMs,
	);
	expect(observation.decisionAt).toBe(origin + 500);
	expect(observation.visibleAtDecision.map(({ id }) => id)).toEqual([
		"update",
		"before-user",
	]);
	expect(observation.laterStandalone.map(({ id }) => id)).toEqual([
		"after-user",
	]);
});

test("a missing reply or incomplete conversation cannot be scored as no proposal", async () => {
	expect(() =>
		observeConversation([message("standalone", 0)], "standalone", windowMs),
	).toThrow("proactive_observation_reply_missing");
	await expect(
		readConversation(
			async () =>
				Response.json({ id: "main", messages: [updateReply], hasMore: true }),
			"main",
		),
	).rejects.toThrow("proactive_conversation_snapshot_invalid");
});

const host = process.env.PROACTIVE_EUMENES_SOURCE;
test.skipIf(!host)(
	"the fixed Eumenes host sends the same standalone message to the user role, judge and aggregate",
	async () => {
		const { harness } = await import(
			pathToFileURL(
				resolve(host!, "api/application/toolchain/toolchain.fixture.ts"),
			).href
		);
		const fixture = await harness();
		try {
			await fixture.conversation.append(updateReply);
			const before = observeConversation(
				await readConversation(fixture.request, "main"),
				updateReply.id,
				windowMs,
			);
			await fixture.conversation.append(
				message("delivered", 900, { text: guidance }),
			);
			await fixture.conversation.append(message("late", 31_000));
			const after = observeConversation(
				await readConversation(fixture.request, "main"),
				updateReply.id,
				windowMs,
			);
			const userView = decisionTranscript(after);
			const judgeView = decisionTranscript(after);
			expect(userView).toEqual(judgeView);
			expect(userView[1]).toEqual({
				order: 1,
				role: "assistant",
				text: guidance,
				offsetMs: 900,
			});
			expect(after.visibleAtDecision[1]?.id).toBe("delivered");
			expect(after.laterStandalone.map(({ id }) => id)).toEqual(["late"]);

			const task = checkInventory(development, holdout).development[0]!;
			const summary = summarizeRuns(
				[before, after].map((observation, index) => ({
					taskId: task.id,
					mode: "C",
					repetition: index + 1,
					status: "completed",
					conditionsMet: true,
					followUps: decisionTranscript(observation).some(
						({ text }) => text === guidance,
					)
						? 0
						: 1,
					rework: 0,
					unnecessaryProposals: 0,
					boundaryViolations: 0,
					foregroundMs: [],
				})),
				[task],
				["C"],
			);
			expect(summary[0]).toMatchObject({
				runs: 2,
				followUps: 1,
				unassistedCompletion: 1,
			});
		} finally {
			await fixture.close();
		}
	},
	15_000,
);
