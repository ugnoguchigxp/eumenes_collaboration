import { z } from "zod";

const messageSchema = z.object({
	id: z.string().min(1),
	conversationId: z.string(),
	role: z.enum(["user", "assistant"]),
	text: z.string(),
	presentation: z.enum(["conversation", "artifact"]).optional(),
	createdAt: z.iso.datetime({ offset: true }),
	runId: z.string().nullable(),
});
const conversationSchema = z.object({
	id: z.string(),
	messages: z.array(messageSchema),
	hasMore: z.boolean().optional(),
});

export type ConversationMessage = z.infer<typeof messageSchema>;

/** Read the same committed conversation messages that the conversation screen receives. */
export async function readConversation(
	request: (path: string) => Promise<Response>,
	conversationId: string,
): Promise<ConversationMessage[]> {
	const response = await request(
		`/api/conversations/${encodeURIComponent(conversationId)}`,
	);
	if (!response.ok)
		throw new Error(`proactive_conversation_http_${response.status}`);
	const conversation = conversationSchema.parse(await response.json());
	if (
		conversation.id !== conversationId ||
		conversation.hasMore ||
		conversation.messages.some(
			(message) => message.conversationId !== conversationId,
		)
	)
		throw new Error("proactive_conversation_snapshot_invalid");
	return conversation.messages;
}

/** Conversation order is authoritative when two messages share the same timestamp. */
export function observeConversation(
	messages: readonly ConversationMessage[],
	updateReplyId: string,
	windowMs: number,
) {
	if (!Number.isSafeInteger(windowMs) || windowMs <= 0)
		throw new Error("proactive_observation_window_invalid");
	const anchorIndex = messages.findIndex(({ id }) => id === updateReplyId);
	const anchor = messages[anchorIndex];
	if (
		!anchor ||
		anchor.role !== "assistant" ||
		anchor.runId === null ||
		anchor.presentation === "artifact"
	)
		throw new Error("proactive_observation_reply_missing");
	if (
		new Set(messages.map(({ id }) => id)).size !== messages.length ||
		messages.some(
			({ conversationId }) => conversationId !== anchor.conversationId,
		)
	)
		throw new Error("proactive_observation_messages_invalid");

	const startedAt = Date.parse(anchor.createdAt);
	const later = messages.slice(anchorIndex + 1);
	const firstUserIndex = later.findIndex(({ role }) => role === "user");
	const decisionAt = Math.min(
		startedAt + windowMs,
		firstUserIndex < 0
			? Infinity
			: Date.parse(later[firstUserIndex]!.createdAt),
	);
	const rows = messages
		.map((message, order) => ({
			...message,
			order,
			offsetMs: Date.parse(message.createdAt) - startedAt,
		}))
		.filter(({ presentation }) => presentation !== "artifact");
	const beforeDecision = (row: (typeof rows)[number]) =>
		row.order <= anchorIndex ||
		(row.offsetMs < windowMs &&
			(firstUserIndex < 0 || row.order < anchorIndex + 1 + firstUserIndex));
	return {
		updateReplyId,
		windowMs,
		startedAt,
		decisionAt,
		visibleAtDecision: rows.filter(beforeDecision),
		laterStandalone: rows.filter(
			(row) =>
				row.role === "assistant" && row.runId === null && !beforeDecision(row),
		),
	};
}

/** The user role and judge both get the same view, without producer or mode identifiers. */
export function decisionTranscript(
	observation: ReturnType<typeof observeConversation>,
) {
	return observation.visibleAtDecision.map(
		({ order, role, text, offsetMs }) => ({
			order,
			role,
			text,
			offsetMs,
		}),
	);
}
