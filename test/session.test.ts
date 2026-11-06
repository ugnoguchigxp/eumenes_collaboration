import { test, expect } from "bun:test";
import { checkSessionDecision, CollaborationError } from "../src/index.ts";
const decision = (text: unknown, closed: boolean) => {
	const result = checkSessionDecision(text, closed);
	return result.ok ? result.decision.decision : result.reason;
};
test("session meaning must be proposed by the model, never inferred from user text", () => {
	for (const text of ["これでいい？", "done", "ありがとう", "another task"])
		expect(decision(text, false)).toBe("decision_invalid");
	expect(
		decision(
			{
				decision: "continue",
				confidence: "low",
				rationale: "確認の質問であり終了ではない",
			},
			false,
		),
	).toBe("continue");
	expect(
		decision(
			{ decision: "close", confidence: "high", rationale: "明示的終了" },
			false,
		),
	).toBe("close");
	expect(
		decision(
			{ decision: "reopen", confidence: "high", rationale: "新しい依頼" },
			true,
		),
	).toBe("reopen");
});
test("schema and current lifecycle constrain model proposals without throwing", () => {
	expect(
		decision({ decision: "close", confidence: "high", rationale: "x" }, true),
	).toBe("session_transition_invalid");
	expect(
		decision({ decision: "reopen", confidence: "high", rationale: "x" }, false),
	).toBe("session_transition_invalid");
	const extra = checkSessionDecision(
		{ decision: "close", confidence: "high", rationale: "", tool: "execute" },
		false,
	);
	expect(extra.ok).toBe(false);
	// Issues name where the proposal broke, never what it said.
	if (!extra.ok) expect(JSON.stringify(extra.issues)).not.toContain("execute");
});
test("an invalid lifecycle from the host is a programming error", () => {
	expect(() =>
		checkSessionDecision(
			{ decision: "close", confidence: "high", rationale: "x" },
			"no" as unknown as boolean,
		),
	).toThrow(CollaborationError);
});
