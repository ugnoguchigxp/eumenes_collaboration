import { expect, test } from "bun:test";
import { collaborationFactSchema, completeBrief } from "../src/index.ts";

const defaults = {
	who: "利用者本人",
	what: "依頼の文面",
	when: "今",
	where: "開始ページ",
	why: "依頼の文面どおり",
	how: "許可された操作",
};

test("given values are confirmed conditions; missing ones are inferred assumptions", () => {
	const brief = completeBrief({
		sourceRef: "req-1",
		given: {
			what: "AI research を検索",
			where: "https://www.youtube.com",
			who: " ",
		},
		defaults,
	});
	expect(brief.inferred).toEqual(["who", "when", "why", "how"]);
	expect(brief.questions).toEqual([]);
	const what = brief.facts.find((f) => f.id === "brief.what");
	expect(what).toMatchObject({ kind: "condition", status: "confirmed" });
	const who = brief.facts.find((f) => f.id === "brief.who");
	expect(who).toMatchObject({
		kind: "assumption",
		status: "proposed",
		value: { slot: "who", value: "利用者本人", inferred: true },
	});
	for (const f of brief.facts)
		expect(collaborationFactSchema.safeParse(f).success).toBe(true);
});

test("only a missing must-ask slot becomes a question; a given one is not asked", () => {
	const missing = completeBrief({
		sourceRef: "r",
		given: { what: "申し込む" },
		defaults,
		mustAsk: [{ slot: "who", reason: "個人情報を送る" }],
	});
	expect(missing.questions).toEqual(["who"]);
	expect(missing.facts.find((f) => f.id === "brief.who")).toMatchObject({
		kind: "question",
		value: { reason: "個人情報を送る" },
	});
	const given = completeBrief({
		sourceRef: "r",
		given: { what: "申し込む", who: "山田" },
		defaults,
		mustAsk: [{ slot: "who", reason: "個人情報を送る" }],
	});
	expect(given.questions).toEqual([]);
});
