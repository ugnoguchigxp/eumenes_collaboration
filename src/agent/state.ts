import {
	CollaborationError,
	issuesOf,
	type Rejected,
	type StateRejectReason,
} from "../contracts/errors.ts";
import { withinJsonLimits } from "../contracts/json-limits.ts";
import {
	collaborationStateSchema,
	stateProposalSchema,
	type CollaborationState,
	type StateHostContext,
} from "../contracts/state.ts";

/** A refused proposal. `staleRefs` names the saved state's inactive sources the host must forget first. */
export type StateRejection = Rejected<StateRejectReason> & {
	staleRefs?: string[];
};
const MAX_STALE_REFS = 256;

const sameWork = (a: StateHostContext["work"], b: StateHostContext["work"]) =>
	a.ref === b.ref && a.revision === b.revision && a.digest === b.digest;

/** Validates provenance and concurrency, never whether a claim matches an utterance's meaning. */
export function proposeStateUpdate(
	saved: unknown,
	proposal: unknown,
	host: StateHostContext,
): { ok: true; state: CollaborationState } | StateRejection {
	const reject = (reason: StateRejectReason): StateRejection => ({
		ok: false,
		reason,
	});
	if (!withinJsonLimits(saved) || !withinJsonLimits(proposal))
		return reject("json_resource_limit");
	const state = collaborationStateSchema.safeParse(saved);
	if (!state.success) return reject("state_schema_unsupported_or_invalid");
	const next = stateProposalSchema.safeParse(proposal);
	if (!next.success) return reject("proposal_invalid");
	const current = state.data;
	const input = next.data;
	if (
		current.sessionId !== host.sessionId ||
		input.sessionId !== host.sessionId ||
		input.epoch !== host.epoch
	)
		return reject("session_changed");
	if (input.expectedRevision !== current.revision)
		return reject("state_revision_conflict");
	if (
		input.sourceRevision !== host.sourceRevision ||
		current.sourceRevision > host.sourceRevision
	)
		return reject("source_revision_conflict");
	if (!sameWork(input.work, host.work)) return reject("work_revision_conflict");
	const refs = new Map(host.sources.map((source) => [source.ref, source]));
	if (refs.size !== host.sources.length)
		return reject("source_registry_invalid");
	const validSources = (sources: string[]) =>
		sources.every((ref) => refs.get(ref)?.active);
	const stale = [
		...new Set(
			current.facts.flatMap((fact) =>
				fact.sourceRefs.filter((ref) => !refs.get(ref)?.active),
			),
		),
	].sort();
	// Fail closed, but say what unblocks it: forget these refs, then propose again.
	if (stale.length)
		return {
			ok: false,
			reason: "state_sources_invalid",
			staleRefs: stale.slice(0, MAX_STALE_REFS),
		};
	if (
		input.upserts.some((fact) => !validSources(fact.sourceRefs)) ||
		input.removals.some((removal) => !validSources(removal.sourceRefs))
	)
		return reject("source_invalid");
	if (
		input.upserts.some(
			(fact) =>
				fact.status === "confirmed" &&
				!fact.sourceRefs.some((ref) => {
					const kind = refs.get(ref)?.kind;
					return kind === "user" || kind === "observation";
				}),
		)
	)
		return reject("confirmation_evidence_required");
	const witnessed = (sources: string[]) =>
		sources.some((ref) => {
			const kind = refs.get(ref)?.kind;
			return kind === "user" || kind === "observation";
		});
	const accepted = new Set(
		current.facts.filter((f) => f.status === "confirmed").map((f) => f.id),
	);
	if (
		input.upserts.some(
			(f) =>
				accepted.has(f.id) &&
				f.status !== "confirmed" &&
				!witnessed(f.sourceRefs),
		) ||
		input.removals.some((f) => accepted.has(f.id) && !witnessed(f.sourceRefs))
	)
		return reject("confirmation_evidence_required");
	const ids = [
		...input.upserts.map((f) => f.id),
		...input.removals.map((f) => f.id),
	];
	if (
		new Set(ids).size !== ids.length ||
		new Set(current.facts.map((f) => f.id)).size !== current.facts.length
	)
		return reject("duplicate_fact");
	const facts = new Map(current.facts.map((fact) => [fact.id, fact]));
	for (const removal of input.removals) {
		if (!facts.delete(removal.id)) return reject("fact_missing");
	}
	for (const fact of input.upserts) facts.set(fact.id, fact);
	for (const fact of facts.values()) {
		if (fact.supersedes.some((id) => id === fact.id || !facts.has(id)))
			return reject("superseded_fact_missing");
	}
	// A supersession graph must be acyclic; it expresses lineage, never execution authority.
	const visiting = new Set<string>();
	const visited = new Set<string>();
	const cycle = (id: string): boolean => {
		if (visiting.has(id)) return true;
		if (visited.has(id)) return false;
		visiting.add(id);
		for (const prior of facts.get(id)!.supersedes)
			if (cycle(prior)) return true;
		visiting.delete(id);
		visited.add(id);
		return false;
	};
	if ([...facts.keys()].some(cycle)) return reject("supersession_cycle");
	// Snapshot accepted edges before retracting their targets; proposal order must not hide an edge.
	const replacements = [...facts.values()].filter(
		(fact) => fact.status === "confirmed",
	);
	for (const fact of replacements)
		for (const prior of fact.supersedes)
			facts.set(prior, { ...facts.get(prior)!, status: "retracted" });
	if (facts.size > 1000) return reject("state_capacity_exceeded");
	const composed = {
		...current,
		revision: current.revision + 1,
		sourceRevision: host.sourceRevision,
		work: { ...host.work },
		facts: structuredClone([...facts.values()]),
	};
	if (!withinJsonLimits(composed)) return reject("json_resource_limit");
	const candidate = collaborationStateSchema.safeParse(composed);
	if (!candidate.success) return reject("candidate_state_invalid");
	return {
		ok: true,
		state: candidate.data,
	};
}

/** Host-triggered forgetting; no proposal may reactivate an invalid source. */
export function forgetStateSources(
	saved: unknown,
	request: {
		sessionId: string;
		expectedRevision: number;
		invalidRefs: ReadonlySet<string>;
		sourceRevision: number;
	},
): { state: CollaborationState; orphaned: string[] } {
	if (
		typeof request !== "object" ||
		request === null ||
		typeof request.sessionId !== "string" ||
		!Number.isSafeInteger(request.expectedRevision) ||
		!Number.isSafeInteger(request.sourceRevision) ||
		!(request.invalidRefs instanceof Set) ||
		[...request.invalidRefs].some((ref) => typeof ref !== "string")
	)
		throw new CollaborationError("forget_request_invalid");
	if (!withinJsonLimits(saved))
		throw new CollaborationError("json_resource_limit");
	const parsed = collaborationStateSchema.safeParse(saved);
	if (!parsed.success)
		throw new CollaborationError(
			"state_schema_unsupported_or_invalid",
			issuesOf(parsed.error),
		);
	const state = parsed.data;
	if (state.sessionId !== request.sessionId)
		throw new CollaborationError("session_changed");
	if (state.revision !== request.expectedRevision)
		throw new CollaborationError("state_revision_conflict");
	if (request.sourceRevision <= state.sourceRevision)
		throw new CollaborationError("source_revision_conflict");
	const invalid = request.invalidRefs;
	const removed = state.facts.filter((fact) =>
		fact.sourceRefs.some((ref) => invalid.has(ref)),
	);
	const removedIds = new Set(removed.map((fact) => fact.id));
	const facts = state.facts.filter((fact) => !removedIds.has(fact.id));
	const kept = new Map(facts.map((fact) => [fact.id, fact]));
	const stillReplaced = new Set(
		facts
			.filter((fact) => fact.status === "confirmed")
			.flatMap((fact) => fact.supersedes),
	);
	// A retracted fact whose only accepted replacements were forgotten stays retracted: the user's intent to drop
	// it may outlive the forgotten words. The host learns of it and asks; the core never restores or words it.
	const orphaned = [
		...new Set(
			removed
				.filter((fact) => fact.status === "confirmed")
				.flatMap((fact) => fact.supersedes),
		),
	]
		.filter(
			(id) => kept.get(id)?.status === "retracted" && !stillReplaced.has(id),
		)
		.sort();
	const candidate = {
		...state,
		revision: state.revision + 1,
		sourceRevision: request.sourceRevision,
		facts: facts.map((fact) => ({
			...fact,
			supersedes: fact.supersedes.filter((id) => kept.has(id)),
		})),
	};
	if (!withinJsonLimits(candidate))
		throw new CollaborationError("json_resource_limit");
	const next = collaborationStateSchema.safeParse(candidate);
	if (!next.success)
		throw new CollaborationError(
			"candidate_state_invalid",
			issuesOf(next.error),
		);
	return { state: next.data, orphaned };
}
