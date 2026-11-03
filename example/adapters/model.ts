import type { ChatMessage } from "eumenes-collaboration";

export type ModelRequest = {
	messages: ChatMessage[];
	outputSchema: Record<string, unknown>;
	signal: AbortSignal;
};
export type ModelResult = { output: unknown; costUsd: number | null };
export interface ModelAdapter {
	infer(request: ModelRequest): Promise<ModelResult>;
}

/** Scripted model outputs test the host contract, never semantic quality. */
export function createFixtureModel(outputs: readonly unknown[]): ModelAdapter {
	let index = 0;
	return {
		async infer(request) {
			request.signal.throwIfAborted();
			if (index >= outputs.length) throw new Error("fixture_exhausted");
			return { output: structuredClone(outputs[index++]), costUsd: 0 };
		},
	};
}
