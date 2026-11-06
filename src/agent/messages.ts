import type {
	ChatMessage,
	CourseEntry,
	TurnContext,
} from "../contracts/index.ts";
import { CollaborationError, issuesOf } from "../contracts/errors.ts";
import { JSON_LIMITS } from "../contracts/json-limits.ts";
import { turnContextSchema } from "../contracts/turn.ts";
import { collaborationInstructions } from "./instructions.ts";
/** Throws `CollaborationError` when the host's context is malformed or its reference data exceeds JSON_LIMITS.bytes. */
export function buildCollaborationMessages(input: TurnContext): ChatMessage[] {
	const checked = turnContextSchema.safeParse(input);
	if (!checked.success)
		throw new CollaborationError(
			"turn_context_invalid",
			issuesOf(checked.error),
		);
	const { course, interrupted, handedOver } = input.course;
	const document = input.document;
	const rejected = document?.rejected;
	const reference = {
		...(handedOver && handedOver !== input.utterance
			? { handedOverRequest: handedOver }
			: {}),
		...(interrupted ? { joinsInterrupted: true } : {}),
		course,
		...(document
			? {
					document: {
						path: document.path,
						revision: document.revision,
						title: document.title,
						...(document.outlined ? { outlined: true } : {}),
						// The screen moved it since the last operation here (undo, redo, the user's own edit).
						...(document.revision !== lastRevision(course)
							? { changedOnScreen: true }
							: {}),
					},
				}
			: { currentWork: input.work.current }),
		// Beside the document: what the work's domain hands the specialist (the choices its document may name).
		...(document && input.work.context !== undefined
			? { workContext: input.work.context }
			: {}),
		// A whole draft that failed its check: what was wrong, and the draft itself when it is small.
		...(rejected
			? {
					rejectedDraft: {
						title: rejected.title,
						issues: rejected.issues,
						...(rejected.fixes.length ? { fixes: rejected.fixes } : {}),
						...(new TextEncoder().encode(rejected.text).length <=
						document.inlineBytes
							? { text: rejected.text }
							: {}),
						createdAt: rejected.createdAt,
					},
				}
			: {}),
		savedRef: input.work.savedRef,
		viewing: input.viewing,
		label: input.work.label,
		dirty: input.work.dirty,
		callsLeft: input.callsLeft,
		...input.time,
	};
	// Measured as sent: the host's values may hold `undefined`, which JSON drops, so the encoded text is the bound.
	const referenceJson = JSON.stringify(reference);
	if (new TextEncoder().encode(referenceJson).length > JSON_LIMITS.bytes)
		throw new CollaborationError("json_resource_limit");
	const block = document
		? `\nCURRENT_DOCUMENT path=${document.path} revision=${document.revision}${document.outlined ? " outline" : ""}\n<<<\n${fenced(document.body)}\n>>>`
		: "";
	return [
		input.system,
		{
			role: "user",
			content: `${collaborationInstructions.reference}\nREFERENCE=${referenceJson}${block}`,
		},
		{
			role: "user",
			content: interrupted
				? `${interrupted}\n${input.utterance}`
				: input.utterance,
		},
	];
}

/** The work's revision after the last operation of the course that reported one (0 before any). */
function lastRevision(course: CourseEntry[]): number {
	for (const entry of [...course].reverse())
		for (const step of [...(entry.steps ?? [])].reverse())
			if (step.revision !== undefined) return step.revision;
	return 0;
}

/** A body line that is exactly the closing fence would end the block early: it gets a leading backslash. */
function fenced(body: string): string {
	return body.replace(/^(\\*)>>>$/gmu, "\\$1>>>");
}
