import type {
	ChatMessage,
	CourseEntry,
	TurnContext,
} from "../contracts/index.ts";
import { collaborationInstructions } from "./instructions.ts";
export function buildCollaborationMessages(input: TurnContext): ChatMessage[] {
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
	const block = document
		? `\nCURRENT_DOCUMENT path=${document.path} revision=${document.revision}${document.outlined ? " outline" : ""}\n<<<\n${document.body}\n>>>`
		: "";
	return [
		input.system,
		{
			role: "user",
			content: `${collaborationInstructions.reference}\nREFERENCE=${JSON.stringify(reference)}${block}`,
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
