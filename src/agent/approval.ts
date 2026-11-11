import { z } from "zod";
import { withinJsonLimits } from "../contracts/json-limits.ts";
import {
	collaborationFactSchema,
	collaborationStateSchema,
	workVersionSchema,
	type StateHostContext,
} from "../contracts/state.ts";

const ref = z.string().min(1).max(256);
/** Issued by the host's real approval interaction, never by the state-proposal model. */
export const stateApprovalSchema = z.strictObject({
	ref,
	sessionId: ref,
	epoch: z.number().int().nonnegative(),
	sourceRef: ref,
	active: z.boolean(),
	work: workVersionSchema,
	fact: collaborationFactSchema,
});
export type StateApproval = z.infer<typeof stateApprovalSchema>;
export type ApprovalHostContext = StateHostContext & {
	approvals: readonly StateApproval[];
};
export const APPROVAL_REJECT_REASONS = [
	"json_resource_limit",
	"state_schema_unsupported_or_invalid",
	"approval_request_invalid",
	"session_changed",
	"state_revision_conflict",
	"source_revision_conflict",
	"work_revision_conflict",
	"source_registry_invalid",
	"approval_registry_invalid",
	"approval_required",
	"approval_target_changed",
	"approval_source_invalid",
	"approval_fact_unconfirmed",
] as const;
export type ApprovalRejectReason = (typeof APPROVAL_REJECT_REASONS)[number];

const requestSchema = z.strictObject({
	factId: ref,
	approvalRef: ref,
	expectedRevision: z.number().int().nonnegative(),
});
// Both operands have already passed the bounded JSON/schema boundary. Object member order is not meaning.
function equivalent(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (
		a === null ||
		b === null ||
		typeof a !== "object" ||
		typeof b !== "object"
	)
		return false;
	if (Array.isArray(a) || Array.isArray(b))
		return (
			Array.isArray(a) &&
			Array.isArray(b) &&
			a.length === b.length &&
			a.every((value, i) => equivalent(value, b[i]))
		);
	const left = a as Record<string, unknown>,
		right = b as Record<string, unknown>;
	const keys = Object.keys(left);
	return (
		keys.length === Object.keys(right).length &&
		keys.every(
			(key) => Object.hasOwn(right, key) && equivalent(left[key], right[key]),
		)
	);
}

/**
 * Gate a host-protected decision at its point of use. A confirmed fact is evidence, not authority.
 * The host selects protected uses and supplies its authoritative approval registry; this function cannot
 * infer consent or issue grants. Call inside the same writer transaction as the protected operation.
 */
export function checkStateApproval(
	saved: unknown,
	request: unknown,
	host: ApprovalHostContext,
):
	| { ok: true; approvalRef: string }
	| { ok: false; reason: ApprovalRejectReason } {
	const reject = (reason: ApprovalRejectReason) => ({
		ok: false as const,
		reason,
	});
	if (
		!withinJsonLimits(saved) ||
		!withinJsonLimits(request) ||
		!withinJsonLimits(host.approvals)
	)
		return reject("json_resource_limit");
	const state = collaborationStateSchema.safeParse(saved);
	if (!state.success) return reject("state_schema_unsupported_or_invalid");
	const parsed = requestSchema.safeParse(request);
	if (!parsed.success) return reject("approval_request_invalid");
	const current = state.data,
		input = parsed.data;
	if (current.sessionId !== host.sessionId) return reject("session_changed");
	if (current.revision !== input.expectedRevision)
		return reject("state_revision_conflict");
	if (current.sourceRevision > host.sourceRevision)
		return reject("source_revision_conflict");
	if (!equivalent(current.work, host.work))
		return reject("work_revision_conflict");
	const refs = new Map(host.sources.map((source) => [source.ref, source]));
	if (refs.size !== host.sources.length)
		return reject("source_registry_invalid");
	const registry = z
		.array(stateApprovalSchema)
		.max(1000)
		.safeParse(host.approvals);
	if (
		!registry.success ||
		new Set(registry.data.map((a) => a.ref)).size !== registry.data.length
	)
		return reject("approval_registry_invalid");
	const approval = registry.data.find((a) => a.ref === input.approvalRef);
	if (!approval?.active) return reject("approval_required");
	if (
		approval.sessionId !== host.sessionId ||
		approval.epoch !== host.epoch ||
		!equivalent(approval.work, host.work)
	)
		return reject("approval_target_changed");
	const source = refs.get(approval.sourceRef);
	if (source?.kind !== "user" || !source.active)
		return reject("approval_source_invalid");
	const facts = current.facts.filter((f) => f.id === input.factId);
	if (facts.length !== 1 || facts[0]!.status !== "confirmed")
		return reject("approval_fact_unconfirmed");
	const fact = facts[0]!;
	if (!fact.sourceRefs.every((sourceRef) => refs.get(sourceRef)?.active))
		return reject("approval_source_invalid");
	if (!equivalent(approval.fact, fact))
		return reject("approval_target_changed");
	return { ok: true, approvalRef: approval.ref };
}
