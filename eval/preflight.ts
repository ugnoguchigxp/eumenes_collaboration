import { ApiBudget } from "../example/adapters/api-budget.ts";
import { createApiModel } from "../example/adapters/api-model.ts";
import { proposeFacts } from "../example/state-turn.ts";
import { proposeDecisions } from "../example/decision-turn.ts";
import { initial, host } from "../test/state.fixture.ts";
import type { TurnContext } from "../src/index.ts";
const budget = new ApiBudget(
	"reports/quality-2026-11-05/api-budget.sqlite",
	10,
);
const input: Omit<TurnContext, "system"> = {
	utterance: "社内申込は部署を必須、メールを不要にしてください。",
	course: { course: [], interrupted: null, handedOver: null },
	work: { label: "fixture", dirty: false, current: {}, savedRef: null },
	viewing: null,
	time: { now: "2026-11-05T00:00:00+09:00", timeZone: "Asia/Tokyo" },
	callsLeft: 1,
};
let failed = false;
try {
	for (const provider of ["anthropic", "openai"] as const) {
		try {
			const model = createApiModel({
				provider,
				model: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna",
				budget,
				maxOutputTokens: 2048,
				timeoutMs: 60000,
			});
			const result = await proposeFacts(
				model,
				input,
				{ ...initial(), facts: [] },
				host(),
				[{ ref: "u1", text: input.utterance }],
				new AbortController().signal,
			);
			const decision = await proposeDecisions(
				model,
				{ ...input, utterance: "2+2を計算してください" },
				false,
				new AbortController().signal,
			);
			const ok =
				result.ok &&
				decision.session.decision === "continue" &&
				decision.plan?.steps[0]?.browser === false;
			if (!ok) failed = true;
			console.log(
				JSON.stringify({
					event: "preflight",
					provider,
					stateAccepted: result.ok,
					decisionAccepted: decision.session.decision === "continue",
					browser: decision.plan?.steps[0]?.browser,
					ok,
				}),
			);
		} catch (e) {
			failed = true;
			console.log(
				JSON.stringify({
					event: "preflight",
					provider,
					error: e instanceof Error ? e.message : "unknown",
				}),
			);
		}
	}
} finally {
	console.log(JSON.stringify({ event: "budget", ...budget.summary() }));
	budget.close();
}
if (failed) process.exitCode = 1;
