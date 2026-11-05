import type { WorkVersion } from "eumenes-collaboration";

export type WorkObservation = {
	ref: string;
	work: WorkVersion;
	capturedAt: string;
	kind: "validation" | "preview" | "trial" | "execution";
	evidence: "fixture" | "rendered" | "live" | "reported";
	result: unknown;
};
export interface ObservationPort {
	current(): WorkVersion;
	capture(target: WorkVersion): Promise<WorkObservation>;
}
const matches = (a: WorkVersion, b: WorkVersion) =>
	a.ref === b.ref && a.revision === b.revision && a.digest === b.digest;

/** A renderer/domain adapter supplies evidence. The core never invents a preview or trial. */
export async function observeCurrent(port: ObservationPort) {
	const target = { ...port.current() };
	const captured = await port.capture({ ...target });
	const observation = { ...captured, work: { ...captured.work } };
	const current = { ...port.current() };
	if (!matches(target, observation.work) || !matches(target, current))
		return { status: "stale" as const, current };
	return { status: "current" as const, observation };
}
