import { z } from "zod";
import {
	sessionDecisionSchema,
	planProposalSchema,
	decideSession,
	planSteps,
	collaborationInstructions,
	buildCollaborationMessages,
	type TurnContext,
} from "eumenes-collaboration";
import type { ModelAdapter } from "./adapters/model.ts";
export const decisionProposalSchema = z.strictObject({
	session: sessionDecisionSchema,
	plan: planProposalSchema.nullable(),
});
export async function proposeDecisions(
	model: ModelAdapter,
	input: Omit<TurnContext, "system">,
	closed: boolean,
	signal: AbortSignal,
) {
	const messages = buildCollaborationMessages({
		...input,
		system: { role: "system", content: collaborationInstructions.decision },
	});
	messages[1]!.content += "\nSESSION_CLOSED=" + JSON.stringify(closed);
	const result = await model.infer({
		messages,
		outputSchema: z.toJSONSchema(decisionProposalSchema),
		signal,
	});
	const proposal = decisionProposalSchema.parse(result.output);
	return {
		session: decideSession(proposal.session, closed),
		plan: proposal.plan ? planSteps(proposal.plan, "current-request") : null,
		costUsd: result.costUsd,
	};
}
