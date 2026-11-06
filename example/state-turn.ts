import { z } from "zod";
import {
	collaborationInstructions,
	buildCollaborationMessages,
	stateProposalSchema,
	collaborationStateSchema,
	proposeStateUpdate,
	withinJsonLimits,
	type StateHostContext,
	type TurnContext,
} from "eumenes-collaboration";
import type { ModelAdapter } from "./adapters/model.ts";

/** The host supplies live refs and original source text; the LLM proposes the meaning. */
export async function proposeFacts(
	model: ModelAdapter,
	context: Omit<TurnContext, "system">,
	saved: unknown,
	host: StateHostContext,
	sourceText: ReadonlyArray<{ ref: string; text: string }>,
	signal: AbortSignal,
	/** `orphaned` ids from the last forgetting: retracted facts whose only replacement was forgotten. */
	options: { reconfirm?: readonly string[] } = {},
) {
	if (!withinJsonLimits(saved))
		return { ok: false as const, reason: "json_resource_limit", costUsd: 0 };
	if (!collaborationStateSchema.safeParse(saved).success)
		return {
			ok: false as const,
			reason: "state_schema_unsupported_or_invalid",
			costUsd: 0,
		};
	const outputSchema = z.toJSONSchema(stateProposalSchema);
	const messages = buildCollaborationMessages({
		...context,
		system: { role: "system", content: collaborationInstructions.state },
	});
	messages[1]!.content +=
		"\nCOLLABORATION_STATE=" +
		JSON.stringify(saved) +
		"\nSOURCE_REGISTRY=" +
		JSON.stringify({ host, sourceText }) +
		(options.reconfirm?.length
			? "\nRECONFIRM=" + JSON.stringify(options.reconfirm)
			: "");
	const result = await model.infer({ messages, outputSchema, signal });
	const checked = proposeStateUpdate(saved, result.output, host);
	return checked.ok
		? {
				...checked,
				proposal: stateProposalSchema.parse(result.output),
				costUsd: result.costUsd,
			}
		: { ...checked, costUsd: result.costUsd };
}
