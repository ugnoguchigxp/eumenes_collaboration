import { expect, test } from "bun:test";
import {
	buildCollaborationMessages,
	collaborationInstructions,
	CollaborationError,
	forgetStateSources,
	JSON_LIMITS,
	proposeStateUpdate,
	STATE_REJECT_REASONS,
	type CollaborationFact,
	type CollaborationState,
	type StateHostContext,
	type StateProposal,
	type TurnContext,
} from "../src/index.ts";
import { snapshotContract } from "./action-schema.fixture.ts";
import snapshot from "./action-schema.snapshot.json";
import { host, initial, proposal } from "./state.fixture.ts";

const nested = (depth: number): unknown =>
	depth ? { child: nested(depth - 1) } : "leaf";
const fact = (
	id: string,
	sourceRefs: string[],
	supersedes: string[] = [],
): CollaborationFact => ({
	id,
	kind: "condition",
	status: "confirmed",
	value: id,
	sourceRefs,
	supersedes,
});

test("every exported state reject reason is reachable", () => {
	type Case = [unknown, StateProposal | unknown, StateHostContext];
	const withProposal = (patch: Partial<StateProposal>): Case => [
		initial(),
		{ ...proposal(), ...patch },
		host(),
	];
	const full = initial();
	full.facts = Array.from({ length: 1000 }, (_, i) => fact(`f${i}`, ["u1"]));
	const cases: Record<(typeof STATE_REJECT_REASONS)[number], Case> = {
		json_resource_limit: withProposal({
			upserts: [{ ...proposal().upserts[0]!, value: nested(70) as never }],
		}),
		state_schema_unsupported_or_invalid: [
			{ ...initial(), stateSchemaVersion: 2 },
			proposal(),
			host(),
		],
		proposal_invalid: [initial(), { ...proposal(), extra: true }, host()],
		session_changed: withProposal({ epoch: 1 }),
		state_revision_conflict: withProposal({ expectedRevision: 3 }),
		source_revision_conflict: withProposal({ sourceRevision: 0 }),
		work_revision_conflict: withProposal({
			work: { ref: "w", revision: 1, digest: "d1" },
		}),
		source_registry_invalid: [
			initial(),
			proposal(),
			{
				...host(),
				sources: [...host().sources, { ref: "u1", kind: "user", active: true }],
			},
		],
		state_sources_invalid: [
			initial(),
			proposal(),
			{
				...host(),
				sources: host().sources.map((s) => ({ ...s, active: s.ref !== "u1" })),
			},
		],
		source_invalid: withProposal({ upserts: [fact("new", ["invented"])] }),
		confirmation_evidence_required: withProposal({
			upserts: [fact("new", ["a1"])],
		}),
		duplicate_fact: withProposal({
			removals: [{ id: "new", sourceRefs: ["u2"] }],
		}),
		fact_missing: withProposal({
			upserts: [],
			removals: [{ id: "absent", sourceRefs: ["u2"] }],
		}),
		superseded_fact_missing: withProposal({
			upserts: [fact("new", ["u2"], ["absent"])],
		}),
		supersession_cycle: withProposal({
			upserts: [
				fact("new", ["u2"], ["prior"]),
				{ ...initial().facts[1]!, supersedes: ["new"] },
			],
		}),
		state_capacity_exceeded: [
			full,
			{ ...proposal(), upserts: [fact("one-more", ["u2"])] },
			host(),
		],
		candidate_state_invalid: [
			{ ...initial(), revision: Number.MAX_SAFE_INTEGER },
			{ ...proposal(), expectedRevision: Number.MAX_SAFE_INTEGER },
			host(),
		],
	};
	expect(Object.keys(cases).sort()).toEqual([...STATE_REJECT_REASONS].sort());
	for (const [reason, [saved, next, context]] of Object.entries(cases))
		expect({
			reason,
			result: proposeStateUpdate(saved, next, context),
		}).toMatchObject({ reason, result: { ok: false, reason } });
});

test("a refused update names the stale sources to forget, and forgetting them unblocks it", () => {
	const revoked = {
		...host(),
		sources: host().sources.map((s) => ({ ...s, active: s.ref !== "u1" })),
	};
	expect(proposeStateUpdate(initial(), proposal(), revoked)).toEqual({
		ok: false,
		reason: "state_sources_invalid",
		staleRefs: ["u1"],
	});
	const { state } = forgetStateSources(initial(), {
		sessionId: "s",
		expectedRevision: 0,
		invalidRefs: new Set(["u1"]),
		sourceRevision: 2,
	});
	const retried = proposeStateUpdate(
		state,
		{
			...proposal(),
			expectedRevision: state.revision,
			sourceRevision: 2,
			upserts: [fact("new", ["u2"])],
		},
		{ ...revoked, sourceRevision: 2 },
	);
	expect(retried.ok).toBe(true);
});

test("forgetting only a correction reports the retracted fact it leaves without a replacement", () => {
	const corrected = (): CollaborationState => ({
		...initial(),
		facts: [
			{ ...fact("c1", ["u1"]), status: "retracted" },
			fact("c2", ["u2"], ["c1"]),
		],
	});
	const forget = (saved: CollaborationState, refs: string[]) =>
		forgetStateSources(saved, {
			sessionId: "s",
			expectedRevision: saved.revision,
			invalidRefs: new Set(refs),
			sourceRevision: 2,
		});
	const correction = forget(corrected(), ["u2"]);
	expect(correction.orphaned).toEqual(["c1"]);
	// It stays retracted: forgetting the words does not restore the condition they dropped.
	expect(correction.state.facts).toEqual([
		{ ...fact("c1", ["u1"]), status: "retracted" },
	]);
	expect(forget(corrected(), ["u1"])).toMatchObject({
		orphaned: [],
		state: { facts: [{ id: "c2", supersedes: [] }] },
	});
	const twice = corrected();
	twice.facts.push(fact("c3", ["u1"], ["c1"]));
	expect(forget(twice, ["u2"]).orphaned).toEqual([]);
	expect(forget(corrected(), []).orphaned).toEqual([]);
});

test("forgetting checks the session, the revision and its own request like any other write", () => {
	const request = {
		sessionId: "s",
		expectedRevision: 0,
		invalidRefs: new Set(["u1"]),
		sourceRevision: 2,
	};
	for (const [patch, code] of [
		[{ sessionId: "other" }, "session_changed"],
		[{ expectedRevision: 1 }, "state_revision_conflict"],
		[{ sourceRevision: 1 }, "source_revision_conflict"],
		[{ invalidRefs: ["u1"] }, "forget_request_invalid"],
		[{ expectedRevision: 0.5 }, "forget_request_invalid"],
	] as const) {
		const call = () =>
			forgetStateSources(initial(), { ...request, ...patch } as never);
		expect(call).toThrow(CollaborationError);
		expect(call).toThrow(code);
	}
	// A 0.2 call shape fails loudly instead of forgetting nothing.
	expect(() =>
		(forgetStateSources as (...args: unknown[]) => unknown)(
			initial(),
			new Set(["u1"]),
			2,
		),
	).toThrow("forget_request_invalid");
	expect(() =>
		forgetStateSources({ ...initial(), stateSchemaVersion: 2 }, request),
	).toThrow("state_schema_unsupported_or_invalid");
});

const context = (): TurnContext => ({
	system: { role: "system", content: collaborationInstructions.rules },
	utterance: "続けて",
	course: { course: [], interrupted: null, handedOver: null },
	work: { label: "作品", current: {}, dirty: false, savedRef: null },
	viewing: null,
	time: { now: "2026-11-04T12:00:00+09:00", timeZone: "Asia/Tokyo" },
	callsLeft: 4,
});

test("a malformed turn context fails with issues that never carry its values", () => {
	for (const [patch, path] of [
		[{ utterance: undefined }, "utterance"],
		[{ callsLeft: "4" }, "callsLeft"],
		[{ course: { course: [{ utterance: "秘密の原文" }] } }, "course"],
		[{ viewing: { ref: 1 } }, "viewing"],
	] as const) {
		let caught: unknown;
		try {
			buildCollaborationMessages({ ...context(), ...patch } as never);
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(CollaborationError);
		const error = caught as CollaborationError;
		expect(error.code).toBe("turn_context_invalid");
		expect(error.issues.some((issue) => issue.path.startsWith(path))).toBe(
			true,
		);
		expect(JSON.stringify(error.issues)).not.toContain("秘密の原文");
	}
});

test("the check never changes what a valid context renders", () => {
	const plain = buildCollaborationMessages(context());
	const extended = buildCollaborationMessages({
		...context(),
		hostOnly: { trace: "x" },
		work: { ...context().work, current: undefined },
	} as TurnContext);
	expect(extended[0]).toEqual(plain[0]!);
	expect(extended[2]).toEqual(plain[2]!);
	expect(extended[1]?.content).not.toContain("hostOnly");
	expect(extended[1]?.content).not.toContain('"currentWork"');
});

test("reference data beyond the JSON byte limit is refused before it is sent", () => {
	const input = context();
	input.work.current = { text: "x".repeat(JSON_LIMITS.bytes) };
	expect(() => buildCollaborationMessages(input)).toThrow(
		"json_resource_limit",
	);
	// The document body is the host's inlineBytes concern, not this bound.
	input.work.current = {};
	input.document = {
		path: "a.md",
		revision: 0,
		title: "a",
		outlined: false,
		body: "x".repeat(JSON_LIMITS.bytes + 1),
		rejected: null,
		inlineBytes: 0,
	};
	expect(buildCollaborationMessages(input)).toHaveLength(3);
});

test("the action check returns the typed action or every violation", () => {
	const contract = snapshotContract();
	expect(contract.check({ action: "reply", text: "はい。" })).toEqual({
		ok: true,
		action: { kind: "reply", text: "はい。" },
	});
	for (const value of [
		{ action: "reply" },
		{ action: "invoke", tool: "doc.edit", forward: true },
		{ action: "reply", text: "x".repeat(301) },
		{ action: "unknown" },
		"reply",
	]) {
		const result = contract.check(value);
		expect(result).toEqual({
			ok: false,
			reason: "action_contract_violation",
			violations: contract.violations(value),
		});
		expect(contract.parse(value)).toBeNull();
		if (!result.ok) expect(result.violations.length).toBeGreaterThan(0);
	}
	expect(
		contract.violationNames(contract.violations({ action: "reply" })),
	).toEqual(["reply:missing=text:unexpected=-"]);
	expect(
		contract.violationNames(
			contract.violations({ action: "reply", text: "x".repeat(301) }),
		),
	).toEqual(["text:chars=301/300:sentences=1/2"]);
	expect(contract.violationNames(contract.violations("reply"))).toEqual([
		"(root):invalid_type",
	]);
});

test("the model-facing action schema is unchanged", () => {
	// Compared as the JSON text a provider receives, key order included.
	expect(JSON.stringify(snapshotContract().outputSchema)).toBe(
		JSON.stringify(snapshot),
	);
});

test("host input errors are typed, named and carry only the code as message", () => {
	const error = new CollaborationError("brief_invalid", [
		{ path: "facts.0.id", code: "too_small" },
	]);
	expect(error).toBeInstanceOf(Error);
	expect(error.name).toBe("CollaborationError");
	expect(error.message).toBe("brief_invalid");
	expect(error.code).toBe("brief_invalid");
	expect(error.issues).toEqual([{ path: "facts.0.id", code: "too_small" }]);
});

test("the reference carries handed-over requests, work context, revisions and only small rejected drafts", () => {
	const input = context();
	input.course.handedOver = "通常担当からの依頼";
	input.course.course = [
		{
			utterance: "見出しを直して",
			outcome: "completed",
			steps: [
				{ tool: "doc.edit", ok: true, revision: 3 },
				{ tool: "doc.check", ok: true },
			],
		},
	];
	input.work.context = { choices: ["A", "B"] };
	input.document = {
		path: "a.md",
		revision: 3,
		title: "a",
		outlined: false,
		body: "本文",
		rejected: {
			title: "案",
			text: "大きすぎる案",
			issues: [{ path: "/", rule: "size" }],
			fixes: [],
			createdAt: "2026-11-06T00:00:00Z",
		},
		inlineBytes: 4,
	};
	const reference = JSON.parse(
		buildCollaborationMessages(input)[1]!
			.content.split("\nREFERENCE=")[1]!
			.split("\nCURRENT_DOCUMENT")[0]!,
	);
	expect(reference.handedOverRequest).toBe("通常担当からの依頼");
	expect(reference.workContext).toEqual({ choices: ["A", "B"] });
	expect(reference.document.changedOnScreen).toBeUndefined();
	expect(reference.rejectedDraft.text).toBeUndefined();
	expect(reference.rejectedDraft.fixes).toBeUndefined();
	input.course.handedOver = input.utterance;
	expect(buildCollaborationMessages(input)[1]!.content).not.toContain(
		'"handedOverRequest"',
	);
});

test("resource inspection refuses non-plain objects, sparse arrays and throwing proxies", async () => {
	const { withinJsonLimits } = await import("../src/index.ts");
	expect(withinJsonLimits(new Date())).toBe(false);
	expect(withinJsonLimits(new (class Box {})())).toBe(false);
	expect(withinJsonLimits(Object.create(null))).toBe(true);
	// eslint-disable-next-line no-sparse-arrays
	expect(withinJsonLimits([1, , 3])).toBe(false);
	const hostile = new Proxy(
		{},
		{
			getOwnPropertyDescriptor() {
				throw new Error("trap");
			},
		},
	);
	expect(withinJsonLimits(hostile)).toBe(false);
});

test("every value the TurnContext type allows still renders, as do undefined nullable fields", () => {
	const plain = buildCollaborationMessages(context());
	const lenient = context() as unknown as Record<string, any>;
	lenient.callsLeft = Infinity;
	lenient.viewing = undefined;
	delete lenient.work.current;
	lenient.course.course = [
		{
			utterance: "直して",
			outcome: "completed",
			steps: [{ tool: "doc.edit", ok: true, revision: -1, size: { a: NaN } }],
		},
	];
	lenient.document = {
		path: "a.md",
		revision: 1.5,
		title: "a",
		outlined: false,
		body: "本文",
		rejected: undefined,
		inlineBytes: Infinity,
	};
	const messages = buildCollaborationMessages(lenient as TurnContext);
	expect(messages).toHaveLength(3);
	expect(messages[2]).toEqual(plain[2]!);
	expect(messages[1]!.content).toContain('"callsLeft":null');
});

test("orphaned names only retracted facts left without any live replacement", () => {
	const forget = (facts: CollaborationFact[], refs: string[]) =>
		forgetStateSources(
			{ ...initial(), facts },
			{
				sessionId: "s",
				expectedRevision: 0,
				invalidRefs: new Set(refs),
				sourceRevision: 2,
			},
		);
	// A <- B <- C: forgetting the middle step leaves C as the topic's live value, so nothing is orphaned.
	const chain = forget(
		[
			{ ...fact("a", ["u1"]), status: "retracted" },
			{ ...fact("b", ["u2"], ["a"]), status: "retracted" },
			fact("c", ["u1"], ["b"]),
		],
		["u2"],
	);
	expect(chain.orphaned).toEqual([]);
	expect(chain.state.facts.map((f) => [f.id, f.status, f.supersedes])).toEqual([
		["a", "retracted", []],
		["c", "confirmed", []],
	]);
	// A fact the user had already withdrawn on its own is still reported: asking again is the safe side.
	expect(
		forget(
			[{ ...fact("a", ["u1"]), status: "retracted" }, fact("b", ["u2"], ["a"])],
			["u2"],
		).orphaned,
	).toEqual(["a"]);
});
