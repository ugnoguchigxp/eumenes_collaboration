import type {
	CollaborationState,
	StateHostContext,
	StateProposal,
} from "../src/index.ts";
export const initial = (): CollaborationState => ({
	stateSchemaVersion: 1,
	coreContractVersion: 1,
	packageVersion: "0.1.0",
	sessionId: "s",
	revision: 0,
	sourceRevision: 1,
	work: { ref: "w", revision: 2, digest: "d2" },
	facts: [
		{
			id: "unchanged",
			kind: "condition",
			status: "confirmed",
			value: { currency: "JPY" },
			sourceRefs: ["u1"],
			supersedes: [],
		},
		{
			id: "prior",
			kind: "condition",
			status: "confirmed",
			value: { required: true },
			sourceRefs: ["u1"],
			supersedes: [],
		},
	],
});
export const host = (): StateHostContext => ({
	sessionId: "s",
	epoch: 2,
	sourceRevision: 1,
	work: { ref: "w", revision: 2, digest: "d2" },
	sources: [
		{ ref: "u1", kind: "user", active: true },
		{ ref: "u2", kind: "user", active: true },
		{ ref: "a1", kind: "assistant", active: true },
	],
});
export const proposal = (): StateProposal => ({
	coreContractVersion: 1,
	sessionId: "s",
	epoch: 2,
	expectedRevision: 0,
	sourceRevision: 1,
	work: { ref: "w", revision: 2, digest: "d2" },
	upserts: [
		{
			id: "new",
			kind: "condition",
			status: "confirmed",
			value: { required: false },
			sourceRefs: ["u2"],
			supersedes: ["prior"],
		},
	],
	removals: [],
});
