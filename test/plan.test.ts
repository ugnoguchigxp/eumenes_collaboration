import { test, expect } from "bun:test";
import {
	planSteps,
	parseBrowserChoice,
	planBudget,
	budgetCheck,
	stepResultFact,
	STEP_RESULT_CHARS,
} from "../src/index.ts";
const step = (id: string, inputs: string[] = []) => ({
	id,
	inputs,
	goal: "モデルが原文から解釈した工程",
	browser: false,
	keepOpen: false,
	output: "findings" as const,
	rationale: "既存情報で対応できる",
});
test("planning accepts structured model decisions without lexical overrides", () => {
	expect(() => planSteps("2+2を計算して", "u")).toThrow();
	const plan = planSteps(
		{ steps: [step("s1"), { ...step("s2", ["s1"]), output: "summary" }] },
		"u",
	);
	expect(plan.steps[0]?.browser).toBe(false);
	expect(plan.facts.every((f) => f.status === "proposed")).toBe(true);
	expect(plan.steps[1]?.inputs).toEqual(["s1"]);
});
test("dependency, duplication, count and browser invariants reject malformed plans", () => {
	for (const steps of [
		[step("s", ["future"])],
		[step("s"), step("s")],
		[{ ...step("s"), keepOpen: true }],
		[],
		Array.from({ length: 6 }, (_, i) => step(`s${i}`)),
	])
		expect(() => planSteps({ steps }, "u")).toThrow();
	expect(() => parseBrowserChoice("summary")).toThrow();
	expect(
		parseBrowserChoice({
			browser: false,
			rationale: "前の結果で十分",
			answer: "結果",
		}).browser,
	).toBe(false);
});
test("bounded results require observations and host budgets fail closed", () => {
	expect(() => stepResultFact("s", "x", [])).toThrow();
	expect(
		(stepResultFact("s", "x".repeat(5000), ["o"]).value as { text: string })
			.text.length,
	).toBe(STEP_RESULT_CHARS + 1);
	expect(planBudget(3).overall).toBe(30);
	expect(budgetCheck(25, planBudget(3)).decision).toBe("ask");
	expect(budgetCheck(30, planBudget(3)).decision).toBe("stop");
	for (const n of [NaN, Infinity, -1, 0, 6, 1.5])
		expect(() => planBudget(n)).toThrow();
	for (const n of [NaN, Infinity, -1, 1.5])
		expect(budgetCheck(n, planBudget(3)).decision).toBe("stop");
	expect(budgetCheck(0, { overall: NaN, perStep: 10 }).decision).toBe("stop");
});

test("accepted step identifiers fit both generated fact prefixes and observation refs are validated", async () => {
	const { collaborationFactSchema } = await import("../src/index.ts");
	const id = "x".repeat(249);
	expect(
		collaborationFactSchema.safeParse(
			planSteps({ steps: [step(id)] }, "u").facts[0],
		).success,
	).toBe(true);
	expect(
		collaborationFactSchema.safeParse(stepResultFact(id, "result", ["o"]))
			.success,
	).toBe(true);
	expect(() => planSteps({ steps: [step(id + "x")] }, "u")).toThrow();
	expect(() => stepResultFact(id + "x", "result", ["o"])).toThrow();
	expect(() => stepResultFact("s", "result", [""])).toThrow();
});
