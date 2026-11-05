import { ApiBudget } from "../example/adapters/api-budget.ts";
import { createApiModel } from "../example/adapters/api-model.ts";
import { z } from "zod";
const budget = new ApiBudget(
	"reports/quality-2026-11-05/api-budget.sqlite",
	10,
);
try {
	for (const provider of ["anthropic", "openai"] as const) {
		try {
			const model = createApiModel({
				provider,
				model: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna",
				budget,
				maxOutputTokens: 512,
				timeoutMs: 60000,
			});
			const result = await model.infer({
				messages: [
					{
						role: "system",
						content: "Return the requested structured JSON only.",
					},
					{ role: "user", content: "Set ok to true." },
				],
				outputSchema: z.toJSONSchema(z.strictObject({ ok: z.boolean() })),
				signal: new AbortController().signal,
			});
			console.log(
				JSON.stringify({
					event: "smoke",
					provider,
					ok: z.strictObject({ ok: z.literal(true) }).safeParse(result.output)
						.success,
					costUsd: result.costUsd,
				}),
			);
		} catch (e) {
			console.log(
				JSON.stringify({
					event: "smoke",
					provider,
					error: e instanceof Error ? e.message : "unknown",
				}),
			);
		}
	}
	console.log(JSON.stringify({ event: "budget", ...budget.summary() }));
} finally {
	budget.close();
}
