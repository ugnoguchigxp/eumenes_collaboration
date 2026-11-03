export type ReplyPolicy = {
	maxChars: number;
	maxSentences: number;
	validate: (text: string) => boolean;
	measure: (text: string) => { chars: number; sentences: number };
	description: string;
};
export type ChatMessage = {
	role: "system" | "user" | "assistant";
	content: string;
};
export type RejectedDraft = {
	title: string;
	text: string;
	issues: Array<{ path: string; rule: string }>;
	fixes: string[];
	createdAt: string;
};
export type SpecialistAction =
	| { kind: "reply"; text: string }
	| {
			kind: "invoke";
			tool: string;
			arguments: Record<string, unknown>;
			/** The reply when the operation succeeds: the turn then ends without another call. */
			text?: string;
	  }
	| { kind: "return"; forward: boolean; text?: string }
	| { kind: "discard"; text?: string };

export type SpecialistViolation =
	| { path: string; code: string; expected?: string }
	| {
			path: "text";
			chars: number;
			maxChars: number;
			sentences: number;
			maxSentences: number;
	  }
	| { action: string; missing: string[]; unexpected: string[] };

type Outcome = "completed" | "failed" | "cancelled" | "interrupted";

/** One earlier turn as the specialist reads it: what was asked, what ran, how it ended. */
export type CourseEntry = {
	utterance: string;
	handedOver?: string;
	steps?: Array<{
		tool: string;
		ok: boolean;
		error?: string;
		revision?: number;
		size?: Record<string, number>;
	}>;
	outcome: Outcome;
	error?: string;
	reply?: string;
};

export type SessionCourse = {
	course: CourseEntry[];
	interrupted: string | null;
	handedOver: string | null;
};
export type TurnContext = {
	system: ChatMessage;
	utterance: string;
	course: SessionCourse;
	work: {
		label: string;
		dirty: boolean;
		current: unknown;
		context?: unknown;
		savedRef: string | null;
	};
	viewing: { toolchainId: string; ref: string; label: string } | null;
	time: { now: string; timeZone: string };
	/** Model calls this turn may make. */
	callsLeft: number;
	/**
	 * The work document, when the session has one: its canonical text (or outline) follows the reference data
	 * as its own block, so the agent copies exact text for `doc.edit` without a second JSON escaping.
	 */
	document?: {
		path: string;
		revision: number;
		title: string;
		outlined: boolean;
		body: string;
		rejected: RejectedDraft | null;
		inlineBytes: number;
	};
};
