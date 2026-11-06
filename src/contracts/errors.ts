import type { z } from "zod";

/**
 * Failure contract. A check of model output returns a `Rejected` value: such output fails as a matter of course.
 * Invalid host input is a programming error and throws `CollaborationError`. Neither carries an input value,
 * only where and how it broke.
 */
export const STATE_REJECT_REASONS = [
	"json_resource_limit",
	"state_schema_unsupported_or_invalid",
	"proposal_invalid",
	"session_changed",
	"state_revision_conflict",
	"source_revision_conflict",
	"work_revision_conflict",
	"source_registry_invalid",
	"state_sources_invalid",
	"source_invalid",
	"confirmation_evidence_required",
	"duplicate_fact",
	"fact_missing",
	"superseded_fact_missing",
	"supersession_cycle",
	"state_capacity_exceeded",
	"candidate_state_invalid",
] as const;
export type StateRejectReason = (typeof STATE_REJECT_REASONS)[number];

export const DECISION_REJECT_REASONS = [
	"decision_invalid",
	"session_transition_invalid",
	"plan_invalid",
	"plan_dependency_invalid",
	"plan_browser_required",
	"browser_choice_invalid",
] as const;
export type DecisionRejectReason = (typeof DECISION_REJECT_REASONS)[number];

export const HOST_INPUT_ERROR_CODES = [
	"turn_context_invalid",
	"json_resource_limit",
	"state_schema_unsupported_or_invalid",
	"forget_request_invalid",
	"session_changed",
	"state_revision_conflict",
	"source_revision_conflict",
	"candidate_state_invalid",
	"session_state_invalid",
	"source_ref_invalid",
	"step_id_invalid",
	"step_result_without_observation",
	"plan_step_count_invalid",
	"brief_invalid",
] as const;
export type HostInputErrorCode = (typeof HOST_INPUT_ERROR_CODES)[number];

/** Where an input broke and the kind of break; never the value. */
export type Issue = { readonly path: string; readonly code: string };
export type Rejected<R extends string> = {
	ok: false;
	reason: R;
	issues?: readonly Issue[];
};

export class CollaborationError extends Error {
	override readonly name = "CollaborationError";
	readonly code: HostInputErrorCode;
	readonly issues: readonly Issue[];
	constructor(code: HostInputErrorCode, issues: readonly Issue[] = []) {
		// The message is the code, as the 0.2 errors were: existing `toThrow(code)` checks keep working.
		super(code);
		this.code = code;
		this.issues = issues;
	}
}

const MAX_ISSUES = 16;
/** A Zod failure as issues: the path and the code, with the received value dropped. */
export function issuesOf(error: z.ZodError): Issue[] {
	return error.issues.slice(0, MAX_ISSUES).map((issue) => ({
		path: issue.path.map(String).join("."),
		code: issue.code,
	}));
}
