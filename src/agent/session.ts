import { z } from "zod";
import {
	CollaborationError,
	issuesOf,
	type Rejected,
} from "../contracts/errors.ts";
export const sessionDecisionSchema = z.strictObject({
	decision: z.enum(["close", "continue", "reopen"]),
	confidence: z.enum(["high", "low"]),
	rationale: z.string().min(1).max(2000),
});
export type SessionDecision = z.infer<typeof sessionDecisionSchema>;
/** Check an LLM proposal; utterance interpretation is never a string matching operation. */
export function checkSessionDecision(
	proposal: unknown,
	closed: boolean,
):
	| { ok: true; decision: SessionDecision }
	| Rejected<"decision_invalid" | "session_transition_invalid"> {
	if (typeof closed !== "boolean")
		throw new CollaborationError("session_state_invalid");
	const result = sessionDecisionSchema.safeParse(proposal);
	if (!result.success)
		return {
			ok: false,
			reason: "decision_invalid",
			issues: issuesOf(result.error),
		};
	const decision = result.data;
	if (
		(closed && decision.decision === "close") ||
		(!closed && decision.decision === "reopen")
	)
		return { ok: false, reason: "session_transition_invalid" };
	return { ok: true, decision };
}
