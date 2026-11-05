import { z } from "zod";
export const sessionDecisionSchema = z.strictObject({
	decision: z.enum(["close", "continue", "reopen"]),
	confidence: z.enum(["high", "low"]),
	rationale: z.string().min(1).max(2000),
});
export type SessionDecision = z.infer<typeof sessionDecisionSchema>;
/** Validate an LLM proposal; utterance interpretation is never a string matching operation. */
export function decideSession(
	proposal: unknown,
	closed: boolean,
): SessionDecision {
	const result = sessionDecisionSchema.parse(proposal);
	if (
		(closed && result.decision === "close") ||
		(!closed && result.decision === "reopen")
	)
		throw new Error("session_transition_invalid");
	return result;
}
