import { test, expect } from "bun:test";
import {
	checkPlan,
	checkBrowserChoice,
	planBudget,
	budgetCheck,
	stepResultFact,
	collaborationFactSchema,
	CollaborationError,
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
const plan = (proposal: unknown, sourceRef = "u") => {
	const result = checkPlan(proposal, sourceRef);
	if (!result.ok) throw new Error(`unexpected ${result.reason}`);
	return result.plan;
};
test("planning accepts structured model decisions without lexical overrides", () => {
	expect(checkPlan("2+2を計算して", "u")).toMatchObject({
		ok: false,
		reason: "plan_invalid",
	});
	const accepted = plan({
		steps: [step("s1"), { ...step("s2", ["s1"]), output: "summary" }],
	});
	expect(accepted.steps[0]?.browser).toBe(false);
	expect(accepted.facts.every((f) => f.status === "proposed")).toBe(true);
	expect(accepted.steps[1]?.inputs).toEqual(["s1"]);
});
test("dependency, duplication, count and browser invariants reject malformed plans", () => {
	for (const [steps, reason] of [
		[[step("s", ["future"])], "plan_dependency_invalid"],
		[[step("s"), step("s")], "plan_dependency_invalid"],
		[[step("s", ["t", "t"])], "plan_dependency_invalid"],
		[[{ ...step("s"), keepOpen: true }], "plan_browser_required"],
		[[], "plan_invalid"],
		[Array.from({ length: 6 }, (_, i) => step(`s${i}`)), "plan_invalid"],
	] as const)
		expect(checkPlan({ steps }, "u")).toMatchObject({ ok: false, reason });
	expect(() => checkPlan({ steps: [step("s")] }, "")).toThrow(
		"source_ref_invalid",
	);
	expect(checkBrowserChoice("summary")).toMatchObject({
		ok: false,
		reason: "browser_choice_invalid",
	});
	expect(
		checkBrowserChoice({
			browser: false,
			rationale: "前の結果で十分",
			answer: "結果",
		}),
	).toMatchObject({ ok: true, choice: { browser: false } });
});
test("bounded results require observations and host budgets fail closed", () => {
	expect(() => stepResultFact("s", "x", [])).toThrow(
		"step_result_without_observation",
	);
	expect(
		(stepResultFact("s", "x".repeat(5000), ["o"]).value as { text: string })
			.text.length,
	).toBe(STEP_RESULT_CHARS + 1);
	expect(planBudget(3).overall).toBe(30);
	expect(planBudget(1).overall).toBe(10);
	expect(budgetCheck(25, planBudget(3)).decision).toBe("ask");
	expect(budgetCheck(30, planBudget(3)).decision).toBe("stop");
	for (const n of [NaN, Infinity, -1, 0, 6, 1.5])
		expect(() => planBudget(n)).toThrow(CollaborationError);
	for (const n of [NaN, Infinity, -1, 1.5])
		expect(budgetCheck(n, planBudget(3)).decision).toBe("stop");
	expect(budgetCheck(0, { overall: NaN, perStep: 10 }).decision).toBe("stop");
});
// String.prototype.isWellFormed is ES2024; this is the same check for the ES2022 lib.
const loneSurrogate =
	/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u;
test("cut step results never split a surrogate pair", () => {
	const text = (result: string) =>
		(stepResultFact("s", result, ["o"]).value as { text: string }).text;
	const emoji = "😀";
	for (const result of [
		"a".repeat(STEP_RESULT_CHARS - 1) + emoji, // the pair straddles the limit
		"a".repeat(STEP_RESULT_CHARS - 1) + emoji + "tail",
		"a".repeat(STEP_RESULT_CHARS - 2) + emoji + "tail", // the pair ends at the limit
		"a".repeat(STEP_RESULT_CHARS),
		"a".repeat(STEP_RESULT_CHARS + 1),
	]) {
		const cut = text(result);
		expect(loneSurrogate.test(cut)).toBe(false);
		expect(cut.length).toBeLessThanOrEqual(STEP_RESULT_CHARS + 1);
	}
	expect(text("a".repeat(STEP_RESULT_CHARS - 1) + emoji + "x")).toBe(
		"a".repeat(STEP_RESULT_CHARS - 1) + "…",
	);
	expect(text("a".repeat(STEP_RESULT_CHARS - 2) + emoji + "x")).toBe(
		"a".repeat(STEP_RESULT_CHARS - 2) + emoji + "…",
	);
});

test("accepted step identifiers fit both generated fact prefixes and observation refs are validated", () => {
	const id = "x".repeat(249);
	expect(
		collaborationFactSchema.safeParse(plan({ steps: [step(id)] }).facts[0])
			.success,
	).toBe(true);
	expect(
		collaborationFactSchema.safeParse(stepResultFact(id, "result", ["o"]))
			.success,
	).toBe(true);
	expect(checkPlan({ steps: [step(id + "x")] }, "u")).toMatchObject({
		ok: false,
		reason: "plan_invalid",
	});
	expect(() => stepResultFact(id + "x", "result", ["o"])).toThrow(
		"step_id_invalid",
	);
	expect(() => stepResultFact("s", "result", [""])).toThrow(
		"source_ref_invalid",
	);
});
