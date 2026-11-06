import type { ModelAdapter, ModelRequest } from "../example/adapters/model.ts";

/** Fixed grader answer used by dry runs: it exercises the pipeline, never measures anything. */
export const DRY_RUN_VERDICT = {
	retained: true,
	noInventedDecision: true,
	unresolvedPreserved: true,
	injectionResisted: true,
	reason: "dry-run fixed verdict",
} as const;

const line = (text: string, name: string): unknown => {
	const match = new RegExp(`^${name}=(.*)$`, "m").exec(text);
	if (!match) throw new Error(`dry_run_${name.toLowerCase()}_missing`);
	return JSON.parse(match[1]!);
};

const properties = (schema: Record<string, unknown>) =>
	(schema.properties ?? {}) as Record<string, unknown>;

/**
 * An offline stand-in for a model. It answers a state request with a valid empty proposal (built from the
 * COLLABORATION_STATE and SOURCE_REGISTRY lines of the prompt), a decision request with a continue/reopen
 * decision, and a grading request with a fixed verdict. It never touches the network.
 */
export function createDryRunModel(
	options: { onRequest?: (request: ModelRequest) => void } = {},
): ModelAdapter {
	return {
		async infer(request) {
			request.signal.throwIfAborted();
			options.onRequest?.(request);
			const keys = properties(request.outputSchema);
			if ("retained" in keys)
				return { output: { ...DRY_RUN_VERDICT }, costUsd: 0 };
			const user = request.messages.map((m) => m.content).join("\n");
			if ("session" in keys) {
				const closed = line(user, "SESSION_CLOSED") === true;
				return {
					output: {
						session: {
							decision: closed ? "reopen" : "continue",
							confidence: "high",
							rationale: "dry-run fixed decision",
						},
						plan: null,
					},
					costUsd: 0,
				};
			}
			const saved = line(user, "COLLABORATION_STATE") as {
				sessionId: string;
				revision: number;
			};
			const registry = line(user, "SOURCE_REGISTRY") as {
				host: {
					epoch: number;
					sourceRevision: number;
					work: unknown;
				};
			};
			return {
				output: {
					coreContractVersion: 1,
					sessionId: saved.sessionId,
					epoch: registry.host.epoch,
					expectedRevision: saved.revision,
					sourceRevision: registry.host.sourceRevision,
					work: registry.host.work,
					upserts: [],
					removals: [],
				},
				costUsd: 0,
			};
		},
	};
}
