import { z } from "zod";
import type { ReplyPolicy } from "../contracts/index.ts";
import { withinJsonLimits } from "../contracts/json-limits.ts";
import { stateProposalSchema } from "../contracts/state.ts";
import { createCollaborationContract } from "./action.ts";

/** Opt-in contract: extract state and choose the next action in the same model call and existing budget. */
export function createStatefulCollaborationContract(policy: ReplyPolicy) {
	const action = createCollaborationContract(policy);
	const {
		$schema: _dialect,
		$defs,
		...stateSchema
	} = z.toJSONSchema(stateProposalSchema);
	return {
		outputSchema: {
			...action.outputSchema,
			properties: {
				...action.outputSchema.properties,
				stateUpdate: stateSchema,
			},
			required: [...(action.outputSchema.required ?? []), "stateUpdate"],
			$defs,
		},
		check(value: unknown) {
			if (!withinJsonLimits(value))
				return { ok: false as const, reason: "json_resource_limit" };
			if (value === null || typeof value !== "object" || Array.isArray(value))
				return { ok: false as const, reason: "stateful_turn_invalid" };
			const { stateUpdate, ...fields } = value as Record<string, unknown>;
			const proposal = stateProposalSchema.safeParse(stateUpdate);
			if (!proposal.success)
				return { ok: false as const, reason: "proposal_invalid" };
			const checked = action.check(fields);
			return checked.ok
				? { ok: true as const, action: checked.action, proposal: proposal.data }
				: checked;
		},
	};
}
