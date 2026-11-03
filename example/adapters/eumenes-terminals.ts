import type {
	ExternalPort,
	ExternalRequest,
	ExternalTarget,
} from "./external.ts";

/** Bind these callbacks to registered Eumenes operations at the application boundary. */
export type EumenesTerminalsBridge = {
	// The host supplies the origin/owner accepted by its existing queue contract.
	enqueue(request: ExternalRequest): Promise<void>;
	stop(
		target: ExternalTarget,
		requestId: string,
	): Promise<"confirmed" | "unconfirmed">;
};

/** Current terminals operations support request/stop, but no structured in-flight answer. */
export function createEumenesTerminalsPort(
	bridge: EumenesTerminalsBridge,
): ExternalPort {
	return {
		async deliver(request) {
			await bridge.enqueue(request);
			return "queued";
		},
		stop: (target, requestId) => bridge.stop(target, requestId),
	};
}
