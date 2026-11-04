import { describe, expect, test } from "bun:test";
import {
	budgetCheck,
	collaborationFactSchema,
	planBudget,
	planSteps,
	stepResultFact,
} from "../src/index.ts";

const MSFT =
	"Google FinanceでMSFTの株価と最新ニュースを調べて、YouTubeで関連する動画を探して再生して、最後にサマリーを教えて";

describe("planSteps", () => {
	test("the MSFT request is three steps: look up, play (kept open), summarize (no browser)", () => {
		const { steps } = planSteps(MSFT, "u1");
		expect(steps.map((s) => s.goal)).toEqual([
			"Google FinanceでMSFTの株価と最新ニュースを調べて",
			"YouTubeで関連する動画を探して再生して",
			"最後にサマリーを教えて",
		]);
		expect(steps.map((s) => [s.needsBrowser, s.keepOpen, s.output])).toEqual([
			[true, false, "findings"],
			[true, true, "screen"],
			[false, false, "summary"],
		]);
		expect(steps[2]?.inputs).toEqual(["s1", "s2"]);
	});

	test("goals are explicit and confirmed; derived fields are inferred and proposed; all facts are valid", () => {
		const { facts } = planSteps(MSFT, "u1");
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
		);
		expect(p.steps.map((s) => [s.needsBrowser, s.output])).toEqual([
			[true, "findings"],
			[true, "findings"],
			[false, "summary"],
		]);
	});
	test("a lone first step that also says まとめ still uses the browser", () => {
		const p = planSteps(
			"crates.ioで serde の最新版を調べてまとめてください",
			"r",
		);
		expect(p.steps).toHaveLength(1);
		expect(p.steps[0]!.needsBrowser).toBe(true);
	});
	test("a list joined by 、 is not split", () => {
		const p = planSteps("東京、大阪、名古屋の天気を調べてください", "r");
		expect(p.steps).toHaveLength(1);
	});
});
