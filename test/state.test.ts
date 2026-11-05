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

test("composed state stays valid at the limit and overflow never reaches the writer", async () => {
	const { collaborationStateSchema } = await import("../src/index.ts");
	const { ExampleStateStore } = await import("../example/state-store.ts");
	const saved = initial();
	saved.facts = Array.from({ length: 1000 }, (_, i) => ({
		...saved.facts[0]!,
		id: `f${i}`,
	}));
	const p = proposal();
	p.upserts[0]!.supersedes = [];
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(saved, 2);
		expect(store.adopt("s", "overflow", p, host())).toEqual({
			ok: false,
			reason: "state_capacity_exceeded",
		});
		expect(store.read("s")).toEqual(saved);
		expect(
			store.db.query("SELECT count(*) AS n FROM example_receipts").get(),
		).toEqual({ n: 0 });
		p.removals = [{ id: "f0", sourceRefs: ["u2"] }];
		expect(store.adopt("s", "replace", p, host()).ok).toBe(true);
		expect(collaborationStateSchema.safeParse(store.read("s")).success).toBe(
			true,
		);
	} finally {
		store.close();
	}
});

test("only accepted replacements retract confirmed facts", () => {
	for (const status of [
		"proposed",
		"rejected",
		"retracted",
		"confirmed",
	] as const) {
		const p = proposal();
		p.upserts[0]!.status = status;
		if (status !== "confirmed") p.upserts[0]!.sourceRefs = ["a1"];
		const result = proposeStateUpdate(initial(), p, host());
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(result.state.facts.find((f) => f.id === "prior")?.status).toBe(
				status === "confirmed" ? "retracted" : "confirmed",
			);
	}
});

test("assistant-only evidence cannot directly demote or remove an accepted condition", () => {
	const p = proposal();
	p.upserts = [
		{ ...initial().facts[1]!, status: "retracted", sourceRefs: ["a1"] },
	];
	expect(proposeStateUpdate(initial(), p, host())).toEqual({
		ok: false,
		reason: "confirmation_evidence_required",
	});
	p.upserts = [];
	p.removals = [{ id: "prior", sourceRefs: ["a1"] }];
	expect(proposeStateUpdate(initial(), p, host())).toEqual({
		ok: false,
		reason: "confirmation_evidence_required",
	});
});

test("resource guards reject depth, cycles and oversized JSON before schema parsing", async () => {
	const { withinJsonLimits, JSON_LIMITS } = await import("../src/index.ts");
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	expect(withinJsonLimits(cycle)).toBe(false);
	let nested: unknown = null;
	for (let i = 0; i < 70; i++) nested = [nested];
	expect(withinJsonLimits(nested)).toBe(false);
	expect(withinJsonLimits("x".repeat(JSON_LIMITS.bytes + 1))).toBe(false);
	const same = { x: "valid" };
	expect(withinJsonLimits([same, same])).toBe(true);
	expect(proposeStateUpdate(initial(), cycle, host())).toEqual({
		ok: false,
		reason: "json_resource_limit",
	});
});

test("seeded state sequences preserve schema, revisions, acceptance and unrelated facts", async () => {
	const { collaborationStateSchema } = await import("../src/index.ts");
	let saved = initial();
	for (let i = 0; i < 100; i++) {
		const p = proposal();
		p.expectedRevision = saved.revision;
		p.upserts = [
			{
				...p.upserts[0]!,
				id: `f${i}`,
				status: i % 3 === 0 ? "proposed" : "confirmed",
				supersedes: [],
			},
		];
		const previous = structuredClone(saved);
		const result = proposeStateUpdate(saved, p, host());
		expect(result.ok).toBe(true);
		expect(saved).toEqual(previous);
		if (result.ok) {
			saved = result.state;
			expect(collaborationStateSchema.safeParse(saved).success).toBe(true);
			expect(saved.revision).toBe(i + 1);
		}
	}
	expect(saved.facts.find((f) => f.id === "unchanged")).toEqual(
		initial().facts[0],
	);
});

test("JSON byte limits include escaped values, keys, UTF-8 and lone surrogates", async () => {
	const { withinJsonLimits, JSON_LIMITS } = await import("../src/index.ts");
	for (const char of ["\n", "\u0000", '"', "\\", "\ud800", "🌸", "漢"]) {
		const width = Buffer.byteLength(JSON.stringify(char)) - 2;
		const text = char.repeat(Math.floor((JSON_LIMITS.bytes - 2) / width));
		expect(withinJsonLimits(text)).toBe(true);
		expect(withinJsonLimits(text + char)).toBe(false);
	}
	const key = "\u0000".repeat(Math.floor(JSON_LIMITS.bytes / 6));
	expect(withinJsonLimits({ [key]: null })).toBe(false);
});

test("composition cannot persist a state exceeding the next read's resource contract", async () => {
	const { ExampleStateStore } = await import("../example/state-store.ts");
	const saved = initial();
	saved.facts[0]!.value = "x".repeat(1100000);
	const p = proposal();
	p.upserts[0]!.value = "y".repeat(1100000);
	p.upserts[0]!.supersedes = [];
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(saved, 2);
		expect(store.adopt("s", "too-large", p, host())).toEqual({
			ok: false,
			reason: "json_resource_limit",
		});
		expect(store.read("s")).toEqual(saved);
		expect(
			store.db.query("SELECT count(*) AS n FROM example_receipts").get(),
		).toEqual({ n: 0 });
	} finally {
		store.close();
	}
});

test("accepted replacement transitions require user/observation evidence across source and status kinds", () => {
	for (const kind of ["user", "observation", "assistant"] as const)
		for (const status of [
			"proposed",
			"confirmed",
			"rejected",
			"retracted",
		] as const) {
			const h = host();
			h.sources = [...h.sources, { ref: "witness", active: true, kind }];
			const p = proposal();
			p.upserts[0]!.sourceRefs = ["witness"];
			p.upserts[0]!.status = status;
			const result = proposeStateUpdate(initial(), p, h);
			expect(result.ok).toBe(!(status === "confirmed" && kind === "assistant"));
			if (result.ok)
				expect(result.state.facts.find((f) => f.id === "prior")?.status).toBe(
					status === "confirmed" ? "retracted" : "confirmed",
				);
		}
});

test("a confirmed correction chain has the same result in every proposal order", () => {
	const base = proposal().upserts[0]!;
	const middle = { ...base, id: "middle", supersedes: ["prior"] };
	const latest = { ...base, id: "latest", supersedes: ["middle"] };
	for (const upserts of [
		[middle, latest],
		[latest, middle],
	]) {
		const result = proposeStateUpdate(
			initial(),
			{ ...proposal(), upserts },
			host(),
		);
		expect(result.ok).toBe(true);
		if (result.ok) {
			for (const id of ["prior", "middle"])
				expect(result.state.facts.find((f) => f.id === id)?.status).toBe(
					"retracted",
				);
			expect(result.state.facts.find((f) => f.id === "latest")?.status).toBe(
				"confirmed",
			);
		}
	}
});

test("forgetting cannot return an invalid revision or an oversized next state", async () => {
	const { JSON_LIMITS } = await import("../src/index.ts");
	const s = initial();
	s.revision = Number.MAX_SAFE_INTEGER;
	expect(() => forgetStateSources(s, new Set(), 2)).toThrow();
	s.revision = 0;
	s.sourceRevision = 9;
	s.facts[0]!.value = "";
	s.facts[0]!.value = "x".repeat(
		JSON_LIMITS.bytes - Buffer.byteLength(JSON.stringify(s)),
	);
	expect(() => forgetStateSources(s, new Set(), 10)).toThrow(
		"json_resource_limit",
	);
});

test("resource inspection rejects hidden serialization hooks without invoking them", async () => {
	const { withinJsonLimits } = await import("../src/index.ts");
	let called = 0;
	const value = {};
	Object.defineProperty(value, "toJSON", {
		value() {
			called++;
			return "unexpected";
		},
	});
	expect(withinJsonLimits(value)).toBe(false);
	expect(called).toBe(0);
	expect(withinJsonLimits({ toJSON: "ordinary JSON data" })).toBe(true);
});
