import { z } from "zod";

const ref = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
export const workVersionSchema = z.strictObject({ ref, revision, digest: ref });
const sources = z.array(ref).min(1).max(64);
export const collaborationFactSchema = z.strictObject({
	id: ref,
	kind: z.enum(["condition", "decision", "assumption", "question"]),
	status: z.enum(["proposed", "confirmed", "rejected", "retracted"]),
	value: z.json(),
	sourceRefs: sources,
	supersedes: z.array(ref).max(64),
});
export const collaborationStateSchema = z.strictObject({
	stateSchemaVersion: z.literal(1),
	coreContractVersion: z.literal(1),
	packageVersion: ref,
	sessionId: ref,
	revision,
	sourceRevision: revision,
	work: workVersionSchema,
	facts: z.array(collaborationFactSchema).max(1000),
});
export const stateProposalSchema = z.strictObject({
	coreContractVersion: z.literal(1),
	sessionId: ref,
	epoch: revision,
	expectedRevision: revision,
	sourceRevision: revision,
	work: workVersionSchema,
	upserts: z.array(collaborationFactSchema).max(1000),
	removals: z.array(z.strictObject({ id: ref, sourceRefs: sources })).max(1000),
});
export type WorkVersion = z.infer<typeof workVersionSchema>;
export type CollaborationFact = z.infer<typeof collaborationFactSchema>;
export type CollaborationState = z.infer<typeof collaborationStateSchema>;
export type StateProposal = z.infer<typeof stateProposalSchema>;
export type StateHostContext = {
	sessionId: string;
	epoch: number;
	sourceRevision: number;
	work: WorkVersion;
	sources: ReadonlyArray<{
		ref: string;
		kind: "user" | "observation" | "assistant" | "host";
		active: boolean;
	}>;
};
