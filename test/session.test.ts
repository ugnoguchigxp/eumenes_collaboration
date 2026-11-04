import { expect, test } from "bun:test";
import { decideSession } from "../src/index.ts";

test("explicit completion closes the session", () => {
	for (const u of [
		"完了",
		"これでいい",
		"これでいいです。",
		"以上です",
		"ありがとう、完了です",
		"はい、これでOK",
		"done",
	])
		expect(decideSession(u, false)).toEqual({
			decision: "close",
			confidence: "high",
			rule: "explicit_done",
		});
});

test("thanks only, or an ambiguous utterance, keeps the session open", () => {
	expect(decideSession("ありがとうございます！", false)).toEqual({
		decision: "continue",
		confidence: "low",
		rule: "thanks_only",
	});
	expect(decideSession("完了したら教えて", false)).toMatchObject({
		decision: "continue",
		confidence: "low",
	});
	expect(decideSession("次は送料を調べて", false)).toEqual({
		decision: "continue",
		confidence: "high",
		rule: "default",
	});
});

test("a new request after completion reopens; thanks after completion stays closed", () => {
	expect(decideSession("やっぱり別の色も探して", true)).toEqual({
		decision: "reopen",
		confidence: "high",
		rule: "new_request",
	});
	expect(decideSession("ありがとう", true)).toEqual({
		decision: "continue",
		confidence: "high",
		rule: "after_close",
	});
	expect(decideSession("完了", true)).toEqual({
		decision: "continue",
		confidence: "high",
		rule: "after_close",
	});
});
