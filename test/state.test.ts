import { expect, test } from "bun:test";
import { forgetStateSources, proposeStateUpdate } from "../src/index.ts";

import { initial, host, proposal } from "./state.fixture.ts";

test("a source-backed correction retracts its predecessor and preserves unrelated facts", () => {
	const saved = initial();
	const result = proposeStateUpdate(saved, proposal(), host());
	expect(result.ok).toBe(true);
	if (!result.ok) return;
	expect(result.state.revision).toBe(1);
	expect(result.state.facts.find((f) => f.id === "unchanged")).toEqual(
		saved.facts[0],
	);
	expect(result.state.facts.find((f) => f.id === "prior")?.status).toBe(
		"retracted",
	);
	expect(saved.revision).toBe(0);
});
test("stale epoch, state, source, and work revisions are refused independently", () => {
	for (const patch of [
		{ epoch: 1 },
		{ expectedRevision: 3 },
		{ sourceRevision: 0 },
		{ work: { ref: "w", revision: 1, digest: "d1" } },
	])
		expect(
			proposeStateUpdate(initial(), { ...proposal(), ...patch }, host()).ok,
		).toBe(false);
});
test("invented refs, assistant-only confirmation, duplicate ids and cyclic lineage are refused", () => {
	for (const sourceRefs of [["invented"], ["a1"]]) {
		const p = proposal();
		p.upserts[0]!.sourceRefs = sourceRefs;
		expect(proposeStateUpdate(initial(), p, host()).ok).toBe(false);
	}
	const duplicate = proposal();
	duplicate.removals = [{ id: "new", sourceRefs: ["u2"] }];
	expect(proposeStateUpdate(initial(), duplicate, host()).ok).toBe(false);
	const cycle = proposal();
	cycle.upserts.push({ ...initial().facts[1]!, supersedes: ["new"] });
	expect(proposeStateUpdate(initial(), cycle, host())).toEqual({
		ok: false,
		reason: "supersession_cycle",
	});
});
test("forgetting removes dependent values and a stale proposal cannot restore them", () => {
	const state = forgetStateSources(initial(), new Set(["u1"]), 2);
	expect(state.facts).toEqual([]);
	const h = host();
	h.sourceRevision = 2;
	h.sources[0]!.active = false;
	const p = proposal();
	p.expectedRevision = state.revision;
	p.sourceRevision = 2;
	p.upserts = [initial().facts[0]!];
	expect(proposeStateUpdate(state, p, h)).toEqual({
		ok: false,
		reason: "source_invalid",
	});
});
test("unsupported persisted versions are held rather than initialized as empty", () => {
	expect(
		proposeStateUpdate(
			{ ...initial(), stateSchemaVersion: 99 },
			proposal(),
			host(),
		),
	).toEqual({ ok: false, reason: "state_schema_unsupported_or_invalid" });
});
