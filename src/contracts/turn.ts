import { z } from "zod";
import type { TurnContext } from "./index.ts";

/**
 * Runtime check of a host's `TurnContext`: the structure the prompt is built from, nothing stricter. Every value
 * the static type allows passes (any number, including non-finite ones), as do `undefined` in nullable fields and
 * an omitted `work.current`, which JSON drops as before. Unknown keys are allowed and the parsed copy is never
 * used: the prompt is built from the host's own values, so a valid input renders byte for byte as before.
 */
const count = z.custom<number>((value) => typeof value === "number");
const courseEntry = z.object({
	utterance: z.string(),
	handedOver: z.string().optional(),
	steps: z
		.array(
			z.object({
				tool: z.string(),
				ok: z.boolean(),
				error: z.string().optional(),
				revision: count.optional(),
				size: z.record(z.string(), count).optional(),
			}),
		)
		.optional(),
	outcome: z.enum(["completed", "failed", "cancelled", "interrupted"]),
	error: z.string().optional(),
	reply: z.string().optional(),
});
export const turnContextSchema = z.object({
	system: z.object({
		role: z.enum(["system", "user", "assistant"]),
		content: z.string(),
	}),
	utterance: z.string(),
	course: z.object({
		course: z.array(courseEntry),
		interrupted: z.string().nullish(),
		handedOver: z.string().nullish(),
	}),
	work: z.object({
		label: z.string(),
		dirty: z.boolean(),
		current: z.unknown().optional(),
		context: z.unknown().optional(),
		savedRef: z.string().nullish(),
	}),
	viewing: z
		.object({ toolchainId: z.string(), ref: z.string(), label: z.string() })
		.nullish(),
	time: z.object({ now: z.string(), timeZone: z.string() }),
	callsLeft: count,
	document: z
		.object({
			path: z.string(),
			revision: count,
			title: z.string(),
			outlined: z.boolean(),
			body: z.string(),
			rejected: z
				.object({
					title: z.string(),
					text: z.string(),
					issues: z.array(z.object({ path: z.string(), rule: z.string() })),
					fixes: z.array(z.string()),
					createdAt: z.string(),
				})
				.nullish(),
			inlineBytes: count,
		})
		.optional(),
});

// The schema must accept every value the static type allows to be built.
type Accepts<T extends z.input<typeof turnContextSchema>> = T;
export type TurnContextIsAccepted = Accepts<TurnContext>;
