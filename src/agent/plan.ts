import type { CollaborationFact } from "../contracts/state.ts";

/**
 * A request split into the steps it names, deterministically (no model call). Each step keeps the user's own
 * words as its goal (explicit, confirmed); what the host derives from them — whether a browser is needed,
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
	needsBrowser: boolean;
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
const WRITE_UP = /(?:記事|文章|レポート|メモ)(?:に(?:して|する|起こ)|を書|として書)/u;
const BROWSER_VERB =
	/検索|調べ|探し|探す|開い|開く|見て|見せ|再生|表示|アクセス|クリック|ページ|サイト|記事|動画|ウィキペディア|wikipedia|https?:\/\//iu;
const KEEP_OPEN =
	/再生|流して|見せて|表示して(?:おいて|ください)?$|開いたままに/u;

function segments(request: string): string[] {
	const parts = request
		.split(SPLIT)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	if (parts.length <= MAX_PLAN_STEPS) return parts;
	const head = parts.slice(0, MAX_PLAN_STEPS - 1);
	return [...head, parts.slice(MAX_PLAN_STEPS - 1).join("、")];
}

export function planSteps(request: string, sourceRef: string): Plan {
	const texts = segments(request);
	const steps: PlanStep[] = texts.map((goal, i) => {
		// The first step always gathers something: "…を調べてまとめて" alone is a browser step, not a summary of nothing.
		const summary =
			i > 0 &&
			(SUMMARY.test(goal) || WRITE_UP.test(goal)) &&
			!/再生|検索|開い|開く|https?:\/\//u.test(goal);
		const needsBrowser = !summary && (BROWSER_VERB.test(goal) || i === 0);
		const keepOpen = needsBrowser && KEEP_OPEN.test(goal);
		return {
			id: `s${i + 1}`,
			goal,
			inputs: texts.slice(0, i).map((_, j) => `s${j + 1}`),
			output: summary ? "summary" : keepOpen ? "screen" : "findings",
			needsBrowser,
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
				needsBrowser: s.needsBrowser,
				keepOpen: s.keepOpen,
			},
			sourceRefs: [sourceRef],
			supersedes: [],
		},
	]);
	return { steps, facts };
}

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
		value: { provenance: "observed", text: result },
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
	const remaining = Math.max(budget.overall - used, 0);
	if (remaining === 0) return { decision: "stop", remaining };
	if (remaining < budget.perStep) return { decision: "ask", remaining };
	return { decision: "go", remaining };
}
