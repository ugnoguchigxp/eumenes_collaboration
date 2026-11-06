import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ModelAdapter } from "./model.ts";
import { withinJsonLimits } from "eumenes-collaboration";

export type ClaudeModelConfig = {
	model: string;
	cwd: string;
	maxBudgetUsd: number;
	maxCalls: number;
	/** Per-call limit (default 120000). A timed-out call has an unknown cost, so the adapter then refuses further calls. */
	timeoutMs?: number;
	/** Omit to inherit the launch environment; an explicit map replaces it for isolated tests. */
	env?: Record<string, string | undefined>;
};

/** Mirrors the model-only SDK boundary in Eumenes's cloud-agents adapter. */
export function createClaudeModel(
	settings: ClaudeModelConfig,
	startQuery: typeof query = query,
): ModelAdapter {
	const config = {
		...settings,
		timeoutMs: settings.timeoutMs ?? 120000,
		...(settings.env === undefined ? {} : { env: { ...settings.env } }),
	};
	if (
		!config.model ||
		!config.cwd ||
		!Number.isFinite(config.maxBudgetUsd) ||
		config.maxBudgetUsd <= 0 ||
		!Number.isSafeInteger(config.maxCalls) ||
		config.maxCalls <= 0 ||
		!Number.isFinite(config.timeoutMs) ||
		config.timeoutMs <= 0
	)
		throw new Error("test_model_configuration_required");
	let calls = 0;
	let spent = 0;
	let unknownCost = false;
	let busy = false;
	return {
		async infer(request) {
			request.signal.throwIfAborted();
			if (
				calls >= config.maxCalls ||
				spent >= config.maxBudgetUsd ||
				unknownCost
			)
				throw new Error("model_budget_exhausted");
			if (
				!withinJsonLimits(request.messages) ||
				!withinJsonLimits(request.outputSchema)
			)
				throw new Error("model_input_capacity_exceeded");
			const first = request.messages[0];
			if (
				first?.role !== "system" ||
				request.messages.slice(1).some((m) => m.role === "system")
			)
				throw new Error("model_instruction_boundary_invalid");

			if (busy) throw new Error("model_call_in_progress");
			busy = true;
			calls++;
			const controller = new AbortController();
			const signal = AbortSignal.any([
				request.signal,
				AbortSignal.timeout(config.timeoutMs),
			]);
			const cancel = () => controller.abort();
			signal.addEventListener("abort", cancel, { once: true });
			if (signal.aborted) controller.abort();
			// A stream that ignores the abort must not hold the caller past the deadline.
			const expired = new Promise<never>((_, reject) => {
				const fail = () =>
					reject(
						request.signal.aborted
							? request.signal.reason
							: new Error("model_call_timeout"),
					);
				if (signal.aborted) fail();
				else signal.addEventListener("abort", fail, { once: true });
			});
			expired.catch(() => undefined);
			const options: Options = {
				cwd: config.cwd,
				...(config.env === undefined ? {} : { env: config.env }),
				model: config.model,
				systemPrompt: first.content,
				tools: [],
				allowedTools: [],
				mcpServers: {},
				strictMcpConfig: true,
				settingSources: [],
				permissionMode: "dontAsk",
				persistSession: false,
				maxTurns: 3,
				maxBudgetUsd: config.maxBudgetUsd - spent,
				abortController: controller,
				outputFormat: { type: "json_schema", schema: request.outputSchema },
			};
			let stream: ReturnType<typeof query> | undefined;
			let result: unknown;
			let cost: number | null = null;
			try {
				stream = startQuery({
					prompt: request.messages
						.slice(1)
						.map((m) => m.content)
						.join("\n\n"),
					options,
				});
				const iterator = stream[Symbol.asyncIterator]();
				while (true) {
					const step = await Promise.race([iterator.next(), expired]);
					if (step.done) break;
					const message = step.value;
					if (message.type !== "result") continue;
					if (
						Number.isFinite(message.total_cost_usd) &&
						message.total_cost_usd >= 0
					)
						cost = message.total_cost_usd;
					if (message.subtype !== "success" || message.is_error)
						throw new Error("model_call_failed");
					result = message.structured_output ?? JSON.parse(message.result);
				}
				request.signal.throwIfAborted();
				if (result === undefined) throw new Error("model_result_missing");
				if (!withinJsonLimits(result))
					throw new Error("model_output_capacity_exceeded");
				return { output: result, costUsd: cost };
			} finally {
				try {
					stream?.close();
				} finally {
					busy = false;
					signal.removeEventListener("abort", cancel);
					if (cost === null) unknownCost = true;
					else spent += cost;
				}
			}
		},
	};
}
