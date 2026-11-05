import type { CollaborationFact } from "../contracts/state.ts";

/**
 * A request split into the steps it names, deterministically (no model call). Each step keeps the user's own
 * words as its goal (explicit, confirmed); what the host derives from them — whether a step uses the browser (or the step decides),
 * whether the browser stays open after the step, which earlier results it reads, what it returns — is an
 * estimate (inferred, proposed). The plan is data for the host: it never widens what the user asked.
 */
export type PlanStep = {
	id: string;
	/** The request text of this step, as the user wrote it. */
	goal: string;
	/** Ids of the earlier steps whose results this step may use. */
	inputs: string[];
	/** What the step returns: findings to hand on, a screen left for the user, or a written summary. */
	output: "findings" | "screen" | "summary";
	/**
	 * Whether the step uses the browser. `plan` decided it from the request alone (a named site or address, or a
	 * first step with nothing known yet); `agent` leaves it to the step's own inference, which sees the signals
	 * and answers from what is known or asks for the browser, saying why (no extra call).
	 */
	browser: BrowserDecision;
	/** The step's result is the screen itself (play, show): its browser outlives the step. */
	keepOpen: boolean;
};

export type Plan = { steps: PlanStep[]; facts: CollaborationFact[] };

/** At most this many steps at first; the rest of the text stays with the last one. */
export const MAX_PLAN_STEPS = 5;
export const STEP_INFERENCE_BUDGET = 10;
export const PLAN_INFERENCE_CAP = 30;

/** Where one step ends and the next begins: a clause ending in て/で followed by 、, そして, それから, 。 */
const SPLIT =
	/(?<=[てで])、(?:そして|それから|その後|次に)?|(?<=(?:調べ|探し|確認し|検索し|開き|読み|見つけ))、|(?<=。)|、(?:そして|それから|その後|次に|最後に)、?/u;
const SUMMARY = /サマリー|まとめ|要約|summar/iu;
/** Writing the result up ("記事にして", "記事を書いて") is a summary, not reading an article on a site (L3). */
const WRITE_UP =
	/(?:記事|文章|レポート|メモ)(?:に(?:して|する|起こ)|を書|として書)/u;
/** Signal words only: they are shown to the deciding agent, never decide on their own. */
const ACTION_WORDS =
	/検索|調べ|探し|探す|開い|開く|見て|見せ|再生|表示|アクセス|クリック|ページ|サイト|記事|動画/iu;
const FRESH_WORDS =
	/最新|今日|今の|現在|いま|直近|速報|安い|最安|価格|値段|上位|ランキング|順位|株価|天気|予報|ニュース|latest|today|current|price|now/iu;

/** A past choice the user or a check found wrong: shown to the agent when a goal is alike. */
export type BrowserHistoryEntry = {
	goal: string;
	/** What was chosen: the browser or not. */
	browser: boolean;
	/** What was right. */
	correct: boolean;
};

export type BrowserSignals = {
	/** The goal names a site or an address. */
	explicitSite: boolean;
	/** The goal asks for an action on a page (search, open, play…). */
	explicitAction: boolean;
	/** The goal asks for something that changes (latest, price, ranking, weather…). */
	freshness: boolean;
	/** Earlier steps whose results this step may answer from. */
	priorResults: string[];
	/** Past misjudgments on alike goals. */
	pastMisjudged: BrowserHistoryEntry[];
};

export type BrowserDecision =
	| { by: "plan"; browser: boolean; rationale: string; signals: BrowserSignals }
	| { by: "agent"; signals: BrowserSignals };

const words = (t: string) =>
	new Set(
		t
			.normalize("NFKC")
			.toLowerCase()
			.match(/[\p{L}\p{N}]{2,}/gu) ?? [],
	);

function alike(a: string, b: string): boolean {
	const x = words(a);
	const y = words(b);
	let common = 0;
	for (const w of x) if (y.has(w)) common++;
	return common > 0 && common / Math.max(1, Math.min(x.size, y.size)) >= 0.5;
}

export function browserSignals(
	goal: string,
	priorResults: string[],
	siteNamed: (goal: string) => boolean = () => false,
	history: readonly BrowserHistoryEntry[] = [],
): BrowserSignals {
	return {
		explicitSite: siteNamed(goal) || /https?:\/\//u.test(goal),
		explicitAction: ACTION_WORDS.test(goal),
		freshness: FRESH_WORDS.test(goal),
		priorResults,
		pastMisjudged: history.filter(
			(h) => h.browser !== h.correct && alike(h.goal, goal),
		),
	};
}
const KEEP_OPEN =
	/再生|流して|見せて|表示して(?:おいて|ください)?$|開いたままに/u;

/** Spans inside 「」『』“”"" — a split there would cut a quoted title or search term in two. */
function quoted(request: string): [number, number][] {
	const spans: [number, number][] = [];
	const re = /「[^」]*」|『[^』]*』|“[^”]*”|"[^"]*"/gu;
	for (const m of request.matchAll(re))
		spans.push([m.index, m.index + m[0].length]);
	return spans;
}

function segments(request: string): string[] {
	const spans = quoted(request);
	const re = new RegExp(SPLIT.source, "gu");
	// [start, end) of each step in the original text; separators are dropped.
	const cuts: [number, number][] = [];
	let from = 0;
	for (const m of request.matchAll(re)) {
		const at = m.index;
		if (spans.some(([a, b]) => at > a && at < b)) continue;
		if (m[0].length === 0 && at === from) continue;
		cuts.push([from, at]);
		from = at + m[0].length;
	}
	cuts.push([from, request.length]);
	const parts = cuts
		.map(([a, b]) => ({ a, text: request.slice(a, b).trim() }))
		.filter((p) => p.text.length > 0);
	if (parts.length <= MAX_PLAN_STEPS) return parts.map((p) => p.text);
	// The rest stays with the last step as the user wrote it (its own 。 and connectives kept).
	const rest = request.slice(parts[MAX_PLAN_STEPS - 1]!.a).trim();
	return [...parts.slice(0, MAX_PLAN_STEPS - 1).map((p) => p.text), rest];
}

export type PlanOptions = {
	/** Whether a goal names a site the browser knows (the host's list); an address always counts. */
	siteNamed?: (goal: string) => boolean;
	/** Past browser-or-not choices found wrong, shown to the step's inference on alike goals. */
	history?: readonly BrowserHistoryEntry[];
};

/**
 * Whether a step uses the browser. Only two cases are settled here, both from facts rather than word lists:
 * the goal names a site or address, or it is the first step (nothing is known yet, so it fetches: the
 * tie-break goes to fresh information). Every other step is left to its own inference with the signals.
 */
function decideBrowser(
	goal: string,
	i: number,
	prior: string[],
	o: PlanOptions,
): BrowserDecision {
	const signals = browserSignals(goal, prior, o.siteNamed, o.history);
	if (signals.explicitSite)
		return { by: "plan", browser: true, rationale: "explicit_site", signals };
	if (i === 0)
		return {
			by: "plan",
			browser: true,
			rationale: "first_step_nothing_known",
			signals,
		};
	return { by: "agent", signals };
}

export function planSteps(
	request: string,
	sourceRef: string,
	options: PlanOptions = {},
): Plan {
	const texts = segments(request);
	const steps: PlanStep[] = texts.map((goal, i) => {
		const inputs = texts.slice(0, i).map((_, j) => `s${j + 1}`);
		const browser = decideBrowser(goal, i, inputs, options);
		const summary =
			i > 0 &&
			browser.by === "agent" &&
			(SUMMARY.test(goal) || WRITE_UP.test(goal));
		const keepOpen =
			browser.by === "plan" && browser.browser && KEEP_OPEN.test(goal);
		return {
			id: `s${i + 1}`,
			goal,
			inputs,
			output: summary ? "summary" : keepOpen ? "screen" : "findings",
			browser,
			keepOpen,
		};
	});
	const facts = steps.flatMap((s): CollaborationFact[] => [
		{
			id: `plan.${s.id}.goal`,
			kind: "condition",
			status: "confirmed",
			value: { provenance: "explicit", goal: s.goal },
			sourceRefs: [sourceRef],
			supersedes: [],
		},
		{
			id: `plan.${s.id}.shape`,
			kind: "assumption",
			status: "proposed",
			value: {
				provenance: "inferred",
				inputs: s.inputs,
				output: s.output,
				browser:
					s.browser.by === "plan"
						? {
								by: "plan",
								browser: s.browser.browser,
								rationale: s.browser.rationale,
							}
						: { by: "agent" },
				keepOpen: s.keepOpen,
			},
			sourceRefs: [sourceRef],
			supersedes: [],
		},
	]);
	return { steps, facts };
}

/** A step result longer than this is cut, so one step cannot flood the next step's context. */
export const STEP_RESULT_CHARS = 1000;

/** A step's result as a fact: confirmed by what the host observed, never by the model's word alone. */
export function stepResultFact(
	stepId: string,
	result: string,
	observationRefs: readonly string[],
): CollaborationFact {
	if (observationRefs.length === 0)
		throw new Error("step_result_without_observation");
	return {
		id: `result.${stepId}`,
		kind: "condition",
		status: "confirmed",
		value: {
			provenance: "observed",
			text:
				result.length > STEP_RESULT_CHARS
					? `${result.slice(0, STEP_RESULT_CHARS)}…`
					: result,
		},
		sourceRefs: [...observationRefs],
		supersedes: [],
	};
}

export type PlanBudget = { perStep: number; overall: number };

/** 10 inferences a step, at most 30 for the whole request. */
export function planBudget(stepCount: number): PlanBudget {
	return {
		perStep: STEP_INFERENCE_BUDGET,
		overall: Math.min(
			Math.max(stepCount, 1) * STEP_INFERENCE_BUDGET,
			PLAN_INFERENCE_CAP,
		),
	};
}

/**
 * Whether the next step may start: `ask` when what is left is less than one step's budget — the host then
 * returns what it has and asks the user whether to go on — and `stop` when nothing is left.
 */
export function budgetCheck(
	used: number,
	budget: PlanBudget,
): { decision: "go" | "ask" | "stop"; remaining: number } {
	// A count the host cannot trust (NaN, negative, infinite) stops rather than going on.
	if (!Number.isFinite(used) || used < 0)
		return { decision: "stop", remaining: 0 };
	const remaining = Math.max(budget.overall - used, 0);
	if (remaining === 0) return { decision: "stop", remaining };
	if (remaining < budget.perStep) return { decision: "ask", remaining };
	return { decision: "go", remaining };
}

/**
 * What the deciding step's inference is told, appended to its own prompt (no extra call): the signals and how
 * to answer. The tie-break goes to fetching: when unsure, use the browser.
 */
export function browserChoicePrompt(signals: BrowserSignals): string {
	const past = signals.pastMisjudged
		.map(
			(h) =>
				`- 「${h.goal}」: ${h.browser ? "ブラウザを使った" : "ブラウザを使わなかった"}が誤り`,
		)
		.join("\n");
	return [
		"このステップでブラウザを使うかは、あなたが決めます。",
		`手がかり: 変わる情報(最新・価格・順位など)=${signals.freshness ? "あり" : "なし"} / ページ上の操作=${signals.explicitAction ? "あり" : "なし"} / 使える前の結果=${signals.priorResults.join(",") || "なし"}`,
		...(past ? [`過去の判断ミス:\n${past}`] : []),
		"前の結果だけで正しく答えられるなら、1行目を「NONE: 理由」にして、続けて答えを書きます。",
		"新しく調べる必要があるなら、1行目を「BROWSER: 理由」だけにします。",
		"迷ったときは新しい情報を取りに行きます（BROWSER を選ぶ）。",
	].join("\n");
}

export type BrowserChoice = {
	browser: boolean;
	rationale: string;
	/** The answer when the browser was not chosen. */
	answer: string;
};

/** Reads the deciding inference's answer. A first line that is neither form is an answer without the browser. */
export function parseBrowserChoice(text: string): BrowserChoice {
	const [first = "", ...rest] = text.trim().split("\n");
	const b = /^BROWSER\s*[:：]\s*(.*)$/u.exec(first.trim());
	if (b) return { browser: true, rationale: b[1]!.trim(), answer: "" };
	const n = /^NONE\s*[:：]\s*(.*)$/u.exec(first.trim());
	if (n)
		return {
			browser: false,
			rationale: n[1]!.trim(),
			answer: rest.join("\n").trim(),
		};
	return { browser: false, rationale: "unstated", answer: text.trim() };
}
