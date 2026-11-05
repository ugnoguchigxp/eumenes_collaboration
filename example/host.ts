import {
	buildCollaborationMessages,
	collaborationInstructions,
	createCollaborationContract,
	type ReplyPolicy,
	type TurnContext,
} from "eumenes-collaboration";
import type { ModelAdapter } from "./adapters/model.ts";

// The example's presentation contract. A voice host supplies its own speech validator.
const measureReply = (text: string) => ({
	chars: text.length,
	sentences: [
		...new Intl.Segmenter("ja", { granularity: "sentence" }).segment(text),
	].filter((s) => s.segment.trim()).length,
});
export const exampleReplyPolicy: ReplyPolicy = {
	maxChars: 300,
	maxSentences: 2,
	validate: (text) => {
		const measured = measureReply(text);
		return measured.chars <= 300 && measured.sentences <= 2;
	},
	measure: measureReply,
	description:
		"利用者への短い返答。replyでは必須。invokeではhostによる成功確定後だけ使う。",
};

/** One inference only. The host must validate and execute an invoke separately. */
export async function propose(
	model: ModelAdapter,
	input: Omit<TurnContext, "system">,
	signal: AbortSignal,
	/** Host-provided schema for the registered operation's arguments; the executor still validates them. */
	toolArgumentsSchema?: Record<string, unknown>,
) {
	const contract = createCollaborationContract(exampleReplyPolicy);
	const outputSchema = toolArgumentsSchema
		? {
				...contract.outputSchema,
				properties: {
					...contract.outputSchema.properties,
					arguments: toolArgumentsSchema,
				},
			}
		: contract.outputSchema;
	const messages = buildCollaborationMessages({
		...input,
		system: {
			role: "system",
			content:
				collaborationInstructions.rules +
				"\n文書の改訂ではCURRENT_DOCUMENTの現在版を原文の正本とし、今回指定された変更だけを反映します。保持が指定された本文・手編集は、句読点・括弧・改行も含め原文をそのまま写します。意味が同じでも保持箇所を言い換えたり、書式を正規化したり、削除したりしません。全文を返す場合も、現在版と採用済みの条件を照合してこの制約を守ります。" +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(outputSchema),
		},
	});
	const result = await model.infer({
		messages,
		outputSchema,
		signal,
	});
	const action = contract.parse(result.output);
	return action
		? { ok: true as const, action, costUsd: result.costUsd }
		: {
				ok: false as const,
				issues: contract.violations(result.output),
				costUsd: result.costUsd,
			};
}
