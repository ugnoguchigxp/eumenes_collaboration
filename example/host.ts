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
) {
	const contract = createCollaborationContract(exampleReplyPolicy);
	const messages = buildCollaborationMessages({
		...input,
		system: {
			role: "system",
			content:
				collaborationInstructions.rules +
				"\nOUTPUT_SCHEMA=" +
				JSON.stringify(contract.outputSchema),
		},
	});
	const result = await model.infer({
		messages,
		outputSchema: contract.outputSchema,
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
