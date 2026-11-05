import { describe, expect, test } from "bun:test";
import {
	budgetCheck,
	collaborationFactSchema,
	planBudget,
	parseBrowserChoice,
	planSteps,
	browserChoicePrompt,
	STEP_RESULT_CHARS,
	stepResultFact,
} from "../src/index.ts";

const SITES =
	/Google Finance|YouTube|PyPI|GitHub|NHK|ウィキペディア|世界銀行|crates\.io|価格\.com/iu;
const O = { siteNamed: (goal: string) => SITES.test(goal) };
/** true/false when the plan settled it, "agent" when the step's inference decides. */
const routed = (s: { browser: { by: string; browser?: boolean } }) =>
	s.browser.by === "plan" ? s.browser.browser : "agent";

const MSFT =
	"Google FinanceでMSFTの株価と最新ニュースを調べて、YouTubeで関連する動画を探して再生して、最後にサマリーを教えて";

describe("planSteps", () => {
	test("the MSFT request is three steps: look up, play (kept open), summarize (no browser)", () => {
		const { steps } = planSteps(MSFT, "u1", O);
		expect(steps.map((s) => s.goal)).toEqual([
			"Google FinanceでMSFTの株価と最新ニュースを調べて",
			"YouTubeで関連する動画を探して再生して",
			"最後にサマリーを教えて",
		]);
		expect(steps.map((s) => [routed(s), s.keepOpen, s.output])).toEqual([
			[true, false, "findings"],
			[true, true, "screen"],
			["agent", false, "summary"],
		]);
		expect(steps[2]?.inputs).toEqual(["s1", "s2"]);
	});

	test("goals are explicit and confirmed; derived fields are inferred and proposed; all facts are valid", () => {
		const { facts } = planSteps(MSFT, "u1", O);
		for (const f of facts) collaborationFactSchema.parse(f);
		const goal = facts.find((f) => f.id === "plan.s1.goal")!;
		const shape = facts.find((f) => f.id === "plan.s1.shape")!;
		expect([
			goal.status,
			(goal.value as { provenance: string }).provenance,
		]).toEqual(["confirmed", "explicit"]);
		expect([
			shape.status,
			(shape.value as { provenance: string }).provenance,
		]).toEqual(["proposed", "inferred"]);
	});

	test("a one-step request stays one step; more than five keep the rest in the fifth", () => {
		expect(planSteps("天気を調べて", "u").steps).toHaveLength(1);
		const long = planSteps(
			"Aを調べて、Bを調べて、Cを調べて、Dを調べて、Eを調べて、Fを調べて",
			"u",
		);
		expect(long.steps).toHaveLength(5);
		expect(long.steps[4]?.goal).toBe("Eを調べて、Fを調べて");
	});

	test("a step result needs an observation behind it", () => {
		expect(() => stepResultFact("s1", "x", [])).toThrow();
		expect(stepResultFact("s1", "$520.99", ["obs:1"]).status).toBe("confirmed");
		const long = stepResultFact("s1", "x".repeat(5000), ["obs:1"]);
		const text = (long.value as { text: string }).text;
		expect(text.length).toBe(STEP_RESULT_CHARS + 1);
		expect(text.endsWith("…")).toBe(true);
	});
});

describe("planSteps splitting (review 2026-11-05)", () => {
	test("a quoted title or search term is never cut in two", () => {
		const { steps } = planSteps(
			"YouTubeで「食べて、祈って、恋をして」を探して、再生して",
			"u",
		);
		expect(steps.map((s) => s.goal)).toEqual([
			"YouTubeで「食べて、祈って、恋をして」を探して",
			"再生して",
		]);
	});

	test("the rest beyond five steps keeps the user's own separators", () => {
		const long = planSteps(
			"Aを調べて、Bを調べて、Cを調べて、Dを調べて、Eを調べた。最後にFをまとめて",
			"u",
		);
		expect(long.steps).toHaveLength(5);
		expect(long.steps[4]?.goal).toBe("Eを調べた。最後にFをまとめて");
	});

	test("an untrustworthy used count stops", () => {
		for (const used of [Number.NaN, -1, Number.POSITIVE_INFINITY])
			expect(budgetCheck(used, planBudget(3)).decision).toBe("stop");
	});
});

describe("planSteps write-up (L3)", () => {
	test("writing the findings up as an article is a summary step, not a browser step", () => {
		const { steps } = planSteps(
			"ウィキペディアで富士山を調べて、ブログ記事にしてください",
			"u",
			O,
		);
		expect(steps).toHaveLength(2);
		expect(routed(steps[1]!)).toBe("agent");
		expect(steps[1]?.output).toBe("summary");
	});

	test("reading an article on a site stays a browser step", () => {
		const { steps } = planSteps(
			"NHKで天気を調べて、関連する記事を開いてください",
			"u",
			O,
		);
		// No site named in the second step: its own inference decides, with the action signal.
		expect(routed(steps[1]!)).toBe("agent");
		expect(steps[1]!.browser.signals.explicitAction).toBe(true);
	});
});

describe("plan budget", () => {
	test("10 a step, at most 30", () => {
		expect(planBudget(1)).toEqual({ perStep: 10, overall: 10 });
		expect(planBudget(3).overall).toBe(30);
		expect(planBudget(5).overall).toBe(30);
	});
	test("asks before a step that could not have its full budget; stops at zero", () => {
		const b = planBudget(3);
		expect(budgetCheck(12, b).decision).toBe("go");
		expect(budgetCheck(25, b)).toEqual({ decision: "ask", remaining: 5 });
		expect(budgetCheck(30, b).decision).toBe("stop");
	});
});

describe("planSteps: 連用形 clauses (2026-11-04)", () => {
	test("「…を調べ、…を見て、まとめて」 is three steps", () => {
		const p = planSteps(
			"PyPIで requests の最新版を調べ、GitHubでそのリポジトリを見て、まとめてください",
			"r",
			O,
		);
		expect(p.steps.map((s) => [routed(s), s.output])).toEqual([
			[true, "findings"],
			[true, "findings"],
			["agent", "summary"],
		]);
	});
	test("a lone first step that also says まとめ still uses the browser", () => {
		const p = planSteps(
			"crates.ioで serde の最新版を調べてまとめてください",
			"r",
			O,
		);
		expect(p.steps).toHaveLength(1);
		expect(routed(p.steps[0]!)).toBe(true);
	});
	test("a list joined by 、 is not split", () => {
		const p = planSteps("東京、大阪、名古屋の天気を調べてください", "r");
		expect(p.steps).toHaveLength(1);
	});
	test("a step that names an article to compare against uses the browser", () => {
		const p = planSteps(
			"世界銀行で日本の人口を調べ、ウィキペディアの日本の記事の人口と比べて、まとめる",
			"r",
			O,
		);
		expect(p.steps.map((s) => [routed(s), s.output])).toEqual([
			[true, "findings"],
			[true, "findings"],
			["agent", "summary"],
		]);
	});
});

describe("browser or not per step (L4, 2026-11-05)", () => {
	test("a first step with nothing known uses the browser (tie-break toward fresh information)", () => {
		const { steps } = planSteps("東京の天気を調べて", "u", O);
		expect(steps[0]!.browser).toMatchObject({
			by: "plan",
			browser: true,
			rationale: "first_step_nothing_known",
		});
	});

	test("an address is a named site even without the host's list", () => {
		const { steps } = planSteps(
			"天気を調べて、https://example.com を読んで",
			"u",
		);
		expect(steps[1]!.browser).toMatchObject({
			by: "plan",
			rationale: "explicit_site",
		});
	});

	test("価格.com then 安い順の上位: the second step is its own inference's to decide, with freshness and the prior result", () => {
		const { steps } = planSteps(
			"価格.comで Nintendo Switch 2 を検索して、安い順の上位を教えて",
			"u",
			O,
		);
		expect(steps).toHaveLength(2);
		const b = steps[1]!.browser;
		expect(b.by).toBe("agent");
		expect(b.signals.freshness).toBe(true);
		expect(b.signals.priorResults).toEqual(["s1"]);
		const prompt = browserChoicePrompt(b.signals);
		expect(prompt).toContain("変わる情報(最新・価格・順位など)=あり");
		expect(prompt).toContain("迷ったときは新しい情報を取りに行きます");
	});

	test("a past misjudgment on an alike goal is shown to the inference", () => {
		const { steps } = planSteps(
			"価格.comで Switch を検索して、安い順の上位を教えて",
			"u",
			{
				...O,
				history: [
					{ goal: "安い順の上位を教えて", browser: false, correct: true },
				],
			},
		);
		expect(steps[1]!.browser.signals.pastMisjudged).toHaveLength(1);
		expect(browserChoicePrompt(steps[1]!.browser.signals)).toContain(
			"過去の判断ミス",
		);
	});

	test("Japanese goals without spaces are matched by character pairs", () => {
		const history = [
			{ goal: "富士山の最初の登頂記録を教えて", browser: false, correct: true },
		];
		const alike = planSteps(
			"ja.wikipedia で浅間山の記事を開いて、浅間山の最初の登頂記録を教えて",
			"u",
			{ ...O, history },
		);
		expect(alike.steps[1]!.browser.signals.pastMisjudged).toHaveLength(1);
		const other = planSteps(
			"ja.wikipedia で浅間山の記事を開いて、近くの温泉の名前を教えて",
			"u",
			{ ...O, history },
		);
		expect(other.steps[1]!.browser.signals.pastMisjudged).toEqual([]);
	});

	test("the answer: BROWSER with a reason, NONE with the answer, anything else is an answer", () => {
		expect(parseBrowserChoice("BROWSER: 価格は変わるので")).toEqual({
			browser: true,
			rationale: "価格は変わるので",
			answer: "",
		});
		expect(
			parseBrowserChoice("NONE: 前の結果で足りる\n最安は 54,099円"),
		).toEqual({
			browser: false,
			rationale: "前の結果で足りる",
			answer: "最安は 54,099円",
		});
		expect(parseBrowserChoice("まとめ")).toEqual({
			browser: false,
			rationale: "unstated",
			answer: "まとめ",
		});
	});
});
