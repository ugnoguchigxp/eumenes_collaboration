import { query, type Options } from "@anthropic-ai/claude-agent-sdk";
import type { ModelAdapter } from "./model.ts";

export type ClaudeModelConfig = {
	model: string;
	cwd: string;
	maxBudgetUsd: number;
	maxCalls: number;
	/** Omit to inherit the launch environment; an explicit map replaces it for isolated tests. */
	env?: Record<string, string | undefined>;
};

/** Mirrors the model-only SDK boundary in Eumenes's cloud-agents adapter. */
export function createClaudeModel(
	config: ClaudeModelConfig,
	startQuery: typeof query = query,
): ModelAdapter {
	if (
		!config.model ||
		!config.cwd ||
		!Number.isFinite(config.maxBudgetUsd) ||
		config.maxBudgetUsd <= 0 ||
		!Number.isSafeInteger(config.maxCalls) ||
		config.maxCalls <= 0
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
			const cancel = () => controller.abort();
			request.signal.addEventListener("abort", cancel, { once: true });
			if (request.signal.aborted) controller.abort();
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
				for await (const message of stream) {
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
				return { output: result, costUsd: cost };
			} finally {
				try {
					stream?.close();
				} finally {
					busy = false;
					request.signal.removeEventListener("abort", cancel);
					if (cost === null) unknownCost = true;
					else spent += cost;
				}
			}
		},
	};
}
