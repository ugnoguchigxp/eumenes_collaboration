import { CollaborationError, issuesOf } from "../contracts/errors.ts";
import {
	collaborationFactSchema,
	type CollaborationFact,
} from "../contracts/state.ts";

export const briefSlots = [
	"who",
	"what",
	"when",
	"where",
	"why",
	"how",
] as const;
export type BriefSlot = (typeof briefSlots)[number];

export type BriefInput = {
	/** Where the given values came from (the request's id); every fact cites it. */
	sourceRef: string;
	/** Values the caller actually has (from the request or the host). Blank strings count as missing. */
	given: Partial<Record<BriefSlot, string>>;
	/** The common-sense value used when a slot is missing; it becomes an assumption marked as inferred. */
	defaults: Record<BriefSlot, string>;
	/**
	 * Slots that must not be guessed (sending, buying, personal data, irreversible steps): when missing they
	 * become a question instead of an assumption. Only these are ever asked.
	 */
	mustAsk?: readonly { slot: BriefSlot; reason: string }[];
};

export type Brief = {
	facts: CollaborationFact[];
	/** Slots filled from `defaults` (shown to the user as 推定). */
	inferred: BriefSlot[];
	/** Slots the user has to answer before the work may rely on them. */
	questions: BriefSlot[];
};

/**
 * 5W1H completion without an explicit plan (v3 decision 4). Deterministic: a given value is a confirmed
 * condition, a missing one is a proposed assumption carrying `inferred: true`, and only a missing `mustAsk`
 * slot becomes a question. Nothing is invented beyond the caller's defaults.
 */
export function completeBrief(input: BriefInput): Brief {
	const facts: CollaborationFact[] = [];
	const inferred: BriefSlot[] = [];
	const questions: BriefSlot[] = [];
	const ask = new Map((input.mustAsk ?? []).map((a) => [a.slot, a.reason]));
	for (const slot of briefSlots) {
		const value = input.given[slot]?.trim();
		const base = {
			id: `brief.${slot}`,
			sourceRefs: [input.sourceRef],
			supersedes: [],
		};
		if (value) {
			facts.push({
				...base,
				kind: "condition",
				status: "confirmed",
				value: { slot, value },
			});
		} else if (ask.has(slot)) {
			questions.push(slot);
			facts.push({
				...base,
				kind: "question",
				status: "proposed",
				value: { slot, reason: ask.get(slot) ?? "" },
			});
		} else {
			inferred.push(slot);
			facts.push({
				...base,
				kind: "assumption",
				status: "proposed",
				value: { slot, value: input.defaults[slot], inferred: true },
			});
		}
	}
	const checked = collaborationFactSchema.array().safeParse(facts);
	if (!checked.success)
		throw new CollaborationError("brief_invalid", issuesOf(checked.error));
	return { facts: checked.data, inferred, questions };
}
