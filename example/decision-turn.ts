import { z } from "zod";
import {
	sessionDecisionSchema,
	planProposalSchema,
	checkSessionDecision,
	checkPlan,
	collaborationInstructions,
	buildCollaborationMessages,
	type Plan,
	type SessionDecision,
	type TurnContext,
} from "eumenes-collaboration";
import type { ModelAdapter } from "./adapters/model.ts";
export const decisionProposalSchema = z.strictObject({
	session: sessionDecisionSchema,
	plan: planProposalSchema.nullable(),
});
/**
 * One inference for the session and plan decisions. `sourceRef` is the host's ref of the current utterance, cited
 * by the plan's facts. A completed inference always reports its cost, whether or not its proposal is accepted;
 * a failed inference throws and its cost stays in the adapter's own ledger.
 */
export async function proposeDecisions(
	model: ModelAdapter,
	input: Omit<TurnContext, "system">,
	closed: boolean,
	sourceRef: string,
	signal: AbortSignal,
): Promise<
	| {
			ok: true;
			session: SessionDecision;
			plan: Plan | null;
			costUsd: number | null;
	  }
	| { ok: false; reason: string; costUsd: number | null }
> {
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
	const costUsd = result.costUsd;
	const proposal = decisionProposalSchema.safeParse(result.output);
	if (!proposal.success)
		return { ok: false, reason: "decision_proposal_invalid", costUsd };
	const session = checkSessionDecision(proposal.data.session, closed);
	if (!session.ok) return { ok: false, reason: session.reason, costUsd };
	if (!proposal.data.plan)
		return { ok: true, session: session.decision, plan: null, costUsd };
	const plan = checkPlan(proposal.data.plan, sourceRef);
	if (!plan.ok) return { ok: false, reason: plan.reason, costUsd };
	return { ok: true, session: session.decision, plan: plan.plan, costUsd };
}
