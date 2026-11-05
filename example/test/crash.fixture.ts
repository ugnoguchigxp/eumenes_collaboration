import { Database } from "bun:sqlite";
import {
	ExampleExternalAdapter,
	requestDigest,
	type ExternalRequest,
	type ExternalPort,
} from "../adapters/external.ts";
export const request: ExternalRequest = {
	requestId: "r",
	collaborationSessionId: "s",
	epoch: 1,
	requestRevision: 1,
	projectRef: "p",
	externalSessionRef: "x",
	generation: 1,
	prompt: "synthetic fixture",
	sourceRefs: ["u"],
	authorityRef: "g",
};
const { authorityRef, ...frozen } = request;
export const host = {
	sessionId: "s",
	target: () => ({
		projectRef: "p",
		externalSessionRef: "x",
		generation: 1,
		inputOwner: "host" as const,
	}),
	grant: () => ({
		ref: authorityRef,
		requestDigest: requestDigest(frozen),
		projectRef: "p",
		externalSessionRef: "x",
		generation: 1,
		requestRevision: 1,
	}),
	epoch: () => 1,
	source: () => ({ active: true, kind: "user" as const }),
};
if (import.meta.main) {
	const db = new Database(process.argv[2]!);
	const port: ExternalPort = {
		async deliver() {
			if (process.argv[3] === "send") process.exit(17);
			return "delivered";
		},
		async stop() {
			process.exit(18);
		},
	};
	const a = new ExampleExternalAdapter(db, port, host);
	await a.submit(request);
	await a.stop("r");
}
