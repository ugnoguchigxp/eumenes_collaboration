import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function createTrialModel(host, model, calls, maxCalls, signal) {
	const { createCloudAgents } = await import(
		pathToFileURL(
			resolve(host, "api/domains/inference/adapters/cloud-agents.ts"),
		).href
	);
	const agents = createCloudAgents(process.env);
	async function complete(lane, request) {
		if (calls.length >= maxCalls)
			throw new Error("trial_model_budget_exhausted");
		const timeoutMs = request.timeoutMs ?? 60_000;
		const entry = { lane, status: "started", timeoutMs };
		calls.push(entry);
		const start = performance.now();
		try {
			const smith =
				lane === "skill-smith"
					? await import(
							new URL(
								"../../../eumenes_skill_smith/src/integration/provider-schema.ts",
								import.meta.url,
							).href
						)
					: null;
			const messages = smith
				? [
						{
							...request.messages[0],
							content:
								request.messages[0].content +
								"\n" +
								smith.strictSchemaInstructions,
						},
						...request.messages.slice(1),
					]
				: request.messages;
			const answer = await agents.run({
				kind: "codex-sdk",
				model,
				baseUrl: "https://api.openai.com/v1",
				credential: null,
				messages,
				reasoningEffort: "low",
				...(lane === "research" ? { nativeWebSearch: true } : {}),
				outputSchema: smith
					? smith.strictProviderSchema(request.outputSchema)
					: request.outputSchema,
				signal: AbortSignal.any([
					request.signal,
					signal,
					AbortSignal.timeout(timeoutMs),
				]),
			});
			Object.assign(entry, {
				status: "received",
				model: answer.usageModel ?? null,
				reasoningTokens: answer.reasoningTokens ?? null,
				inputTokens: answer.inputTokens,
				outputTokens: answer.outputTokens,
			});
			const parsed = JSON.parse(
				answer.text
					.trim()
					.replace(/^```(?:json)?[ \t]*\r?\n([\s\S]+)\r?\n```$/i, "$1"),
			);
			const output = smith
				? smith.decodeProviderValue(parsed.result, request.outputSchema)
				: parsed;
			if (smith) {
				entry.skillDecision = {
					stage: request.stage,
					ref: output.ref,
					reason: output.reason,
				};
			}
			entry.status = "ok";
			return {
				output,
				costUsd: null,
				inputTokens: answer.inputTokens,
				outputTokens: answer.outputTokens,
				model: answer.usageModel ?? model,
			};
		} catch (error) {
			entry.status = "failed";
			throw error;
		} finally {
			entry.elapsedMs = Math.round(performance.now() - start);
		}
	}

	return complete;
}
