import { expect, test } from "bun:test";
import type { TurnContext } from "eumenes-collaboration";
import type { ModelAdapter, ModelRequest } from "../adapters/model.ts";
import { proposeFacts } from "../state-turn.ts";
import { host, initial } from "../../test/state.fixture.ts";

const context: Omit<TurnContext, "system"> = {
	utterance: "色はどうなっていますか。",
	course: { course: [], interrupted: null, handedOver: null },
	work: { label: "fixture", dirty: false, current: {}, savedRef: null },
	viewing: null,
	time: { now: "2026-11-06T00:00:00+09:00", timeZone: "Asia/Tokyo" },
	callsLeft: 1,
};
const capture = () => {
	const requests: ModelRequest[] = [];
	const model: ModelAdapter = {
		async infer(request) {
			requests.push(request);
			return { output: null, costUsd: 0.001 };
		},
	};
	return { model, requests };
};

test("ids orphaned by forgetting reach the state turn only when there are some", async () => {
	for (const [reconfirm, expected] of [
		[["c1"], '\nRECONFIRM=["c1"]'],
		[[], null],
		[undefined, null],
	] as const) {
		const { model, requests } = capture();
		const result = await proposeFacts(
			model,
			context,
			initial(),
			host(),
			[{ ref: "u1", text: context.utterance }],
			new AbortController().signal,
			reconfirm === undefined ? undefined : { reconfirm },
		);
		// The scripted output is not a proposal: it is refused, and the completed call still reports its cost.
		expect(result).toMatchObject({ ok: false, costUsd: 0.001 });
		const content = requests[0]!.messages[1]!.content;
		if (expected) expect(content.endsWith(expected)).toBe(true);
		else expect(content).not.toContain("RECONFIRM=");
	}
});
