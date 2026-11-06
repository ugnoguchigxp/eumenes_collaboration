import { createCollaborationContract } from "../src/index.ts";

/** A fixed reply policy, so the model-facing schema can be compared byte for byte. */
export const snapshotContract = () =>
	createCollaborationContract({
		maxChars: 300,
		maxSentences: 2,
		validate: (text) => text.length <= 300,
		measure: (text) => ({ chars: text.length, sentences: 1 }),
		description: "host reply policy",
	});
