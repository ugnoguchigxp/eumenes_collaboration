import { test, expect } from "bun:test";
import { decideSession } from "../src/index.ts";
test("session meaning must be proposed by the model, never inferred from user text", () => {
	for (const text of ["これでいい？", "done", "ありがとう", "another task"])
		expect(() => decideSession(text, false)).toThrow();
	expect(
		decideSession(
			{
				decision: "continue",
				confidence: "low",
				rationale: "確認の質問であり終了ではない",
			},
			false,
		).decision,
	).toBe("continue");
	expect(
		decideSession(
			{ decision: "close", confidence: "high", rationale: "明示的終了" },
			false,
		).decision,
	).toBe("close");
	expect(
		decideSession(
			{ decision: "reopen", confidence: "high", rationale: "新しい依頼" },
			true,
		).decision,
	).toBe("reopen");
});
test("schema and current lifecycle constrain model proposals", () => {
	expect(() =>
		decideSession(
			{ decision: "close", confidence: "high", rationale: "x" },
			true,
		),
	).toThrow("session_transition_invalid");
	expect(() =>
		decideSession(
			{ decision: "reopen", confidence: "high", rationale: "x" },
			false,
		),
	).toThrow("session_transition_invalid");
	expect(() =>
		decideSession(
			{ decision: "close", confidence: "high", rationale: "", tool: "execute" },
			false,
		),
	).toThrow();
});
