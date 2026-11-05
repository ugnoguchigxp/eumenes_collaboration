/**
 * Whether a user's utterance ends the conversation. The session stays open unless the user explicitly says
 * the work is done; thanks alone, or anything ambiguous, keeps it open. A new request after a close reopens it.
 * Deterministic (no model call): the host may still ask the model when `confidence` is "low".
 */
export type SessionDecision = {
	decision: "close" | "continue" | "reopen";
	confidence: "high" | "low";
	/** Which rule decided (for the log; never the utterance). */
	rule:
		"explicit_done" | "thanks_only" | "new_request" | "after_close" | "default";
};

const norm = (text: string) =>
	text
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\s。、！!？?.,〜~ー…]+/g, "");

/** Whole-utterance phrases that end the session (after normalization; optional politeness around them). */
const DONE = [
	"完了",
	"完了です",
	"完了しました",
	"これでいい",
	"これでいいです",
	"これでよい",
	"これでok",
	"これで大丈夫",
	"これで大丈夫です",
	"以上",
	"以上です",
	"終わり",
	"終わりです",
	"終了",
	"終了です",
	"おしまい",
	"もう大丈夫",
	"もう大丈夫です",
	"done",
	"thatsall",
	"allset",
];
const THANKS = [
	"ありがとう",
	"ありがとうございます",
	"ありがとうございました",
	"どうも",
	"thanks",
	"thankyou",
	"サンキュー",
];
const PREFIX = ["", "はい", "うん", "ok", "了解"];

// The lists go through the same normalization as the utterance ("サンキュー" loses its ー there too).
const DONE_N = DONE.map(norm);
const THANKS_N = [...new Set(THANKS.map(norm))].sort(
	(a, b) => b.length - a.length,
);
const PREFIX_N = PREFIX.map(norm);

function stripThanks(text: string): string {
	let out = text;
	for (const t of THANKS_N) out = out.split(t).join("");
	return out;
}

export function decideSession(
	utterance: string,
	closed: boolean,
): SessionDecision {
	const text = norm(utterance);
	const core = stripThanks(text);
	const explicit = PREFIX_N.some((p) => DONE_N.some((d) => core === p + d));
	if (!closed && explicit)
		return { decision: "close", confidence: "high", rule: "explicit_done" };
	if (core === "" && text !== "")
		return closed
			? { decision: "continue", confidence: "high", rule: "after_close" }
			: { decision: "continue", confidence: "low", rule: "thanks_only" };
	if (closed)
		return explicit || core === ""
			? { decision: "continue", confidence: "high", rule: "after_close" }
			: { decision: "reopen", confidence: "high", rule: "new_request" };
	// Mentions of done inside a longer request ("完了したら教えて") are not a close.
	return {
		decision: "continue",
		confidence:
			text.includes("完了") || text.includes("これでいい") ? "low" : "high",
		rule: "default",
	};
}
