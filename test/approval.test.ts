import { expect, test } from "bun:test";
import {
	checkStateApproval,
	proposeStateUpdate,
	type ApprovalHostContext,
} from "../src/index.ts";
import { initial, host, proposal } from "./state.fixture.ts";

const fixture = () => {
	const state = initial();
	const context: ApprovalHostContext = {
		...host(),
		approvals: [
			{
				ref: "review:1",
				sessionId: "s",
				epoch: 2,
				sourceRef: "u2",
				active: true,
				work: structuredClone(state.work),
				fact: structuredClone(state.facts[1]!),
			},
		],
	};
	const request = {
		factId: "prior",
		approvalRef: "review:1",
		expectedRevision: 0,
	};
	return { state, context, request };
};

test("a host approval binds an actual user source to the exact reviewed fact and work", () => {
	const f = fixture();
	expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
		ok: true,
		approvalRef: "review:1",
	});
});

test("confirmed source-backed decisions never create authority, even with a claimed approval field", () => {
	for (const kind of ["user", "observation"] as const) {
		const f = fixture();
		f.context.sources = [
			...f.context.sources,
			{ ref: "material", kind, active: true },
		];
		const p = proposal();
		p.upserts = [
			{
				...p.upserts[0]!,
				id: "operation",
				kind: "decision",
				value: { approved: true, effect: "publish" },
				sourceRefs: ["material"],
				supersedes: [],
			},
		];
		const result = proposeStateUpdate(f.state, p, f.context);
		expect(result.ok).toBe(true);
		if (result.ok)
			expect(
				checkStateApproval(
					result.state,
					{ ...f.request, factId: "operation", expectedRevision: 1 },
					{ ...f.context, approvals: [] },
				),
			).toEqual({ ok: false, reason: "approval_required" });
	}
});

test("existing approvals cannot be reused for changed decisions, sources or lineage", () => {
	for (const patch of [
		{ value: { required: false } },
		{ kind: "decision" },
		{ id: "other" },
		{ sourceRefs: ["u2"] },
		{ supersedes: ["unchanged"] },
	]) {
		const f = fixture();
		Object.assign(f.state.facts[1]!, patch);
		f.request.factId = f.state.facts[1]!.id;
		expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
			ok: false,
			reason: "approval_target_changed",
		});
	}
});

test("an approval is bound to session, epoch and each work-version component", () => {
	for (const patch of [
		{ sessionId: "another" },
		{ epoch: 3 },
		{ work: { ref: "other", revision: 2, digest: "d2" } },
		{ work: { ref: "w", revision: 3, digest: "d2" } },
		{ work: { ref: "w", revision: 2, digest: "changed" } },
	]) {
		const f = fixture();
		f.context.approvals = [{ ...f.context.approvals[0]!, ...patch }];
		expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
			ok: false,
			reason: "approval_target_changed",
		});
	}
});

test("inactive approvals and revoked, absent or non-user approval sources cannot authorize", () => {
	for (const kind of ["observation", "assistant", "host"] as const) {
		const f = fixture();
		f.context.sources = f.context.sources.map((s) =>
			s.ref === "u2" ? { ...s, kind } : s,
		);
		expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
			ok: false,
			reason: "approval_source_invalid",
		});
	}
	for (const ref of ["u1", "u2"]) {
		const f = fixture();
		f.context.sources = f.context.sources.map((s) => ({
			...s,
			active: s.ref !== ref,
		}));
		expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
			ok: false,
			reason: "approval_source_invalid",
		});
	}
	const f = fixture();
	f.context.approvals = [{ ...f.context.approvals[0]!, active: false }];
	expect(checkStateApproval(f.state, f.request, f.context)).toEqual({
		ok: false,
		reason: "approval_required",
	});
});

test("the point-of-use check fences stale state, work, source and fact status", () => {
	for (const status of ["proposed", "rejected", "retracted"] as const) {
		const f = fixture();
		f.state.facts[1]!.status = status;
		expect(checkStateApproval(f.state, f.request, f.context)).toMatchObject({
			ok: false,
			reason: "approval_fact_unconfirmed",
		});
	}
	const f = fixture();
	expect(
		checkStateApproval(
			f.state,
			{ ...f.request, expectedRevision: 1 },
			f.context,
		),
	).toMatchObject({ reason: "state_revision_conflict" });
	expect(
		checkStateApproval(f.state, f.request, { ...f.context, sourceRevision: 0 }),
	).toMatchObject({ reason: "source_revision_conflict" });
	expect(
		checkStateApproval(f.state, f.request, {
			...f.context,
			work: { ...f.context.work, revision: 3 },
		}),
	).toMatchObject({ reason: "work_revision_conflict" });
});

test("unrelated state revisions preserve approval while JSON keys and scalar/array content stay distinguishable", () => {
	const f = fixture();
	f.state.facts[1]!.value = { a: [1, { x: null }], b: false };
	f.context.approvals = [
		{
			...f.context.approvals[0]!,
			fact: { ...f.state.facts[1]!, value: { b: false, a: [1, { x: null }] } },
		},
	];
	f.state.revision = 1;
	f.state.facts[0]!.value = { currency: "EUR" };
	expect(
		checkStateApproval(
			f.state,
			{ ...f.request, expectedRevision: 1 },
			f.context,
		).ok,
	).toBe(true);
	for (const value of [
		{ a: [2, { x: null }], b: false },
		{ a: [1, { x: null }], b: 0 },
		{ a: [1, null], b: false },
	]) {
		f.state.facts[1]!.value = value;
		expect(
			checkStateApproval(
				f.state,
				{ ...f.request, expectedRevision: 1 },
				f.context,
			).ok,
		).toBe(false);
	}
});

test("malformed requests, duplicate registry identities and resource excess fail closed", () => {
	const f = fixture();
	expect(
		checkStateApproval(f.state, { ...f.request, approved: true }, f.context),
	).toMatchObject({ reason: "approval_request_invalid" });
	expect(
		checkStateApproval(f.state, f.request, {
			...f.context,
			sources: [...f.context.sources, f.context.sources[0]!],
		}),
	).toMatchObject({ reason: "source_registry_invalid" });
	expect(
		checkStateApproval(f.state, f.request, {
			...f.context,
			approvals: [...f.context.approvals, f.context.approvals[0]!],
		}),
	).toMatchObject({ reason: "approval_registry_invalid" });
	const cycle: Record<string, unknown> = {};
	cycle.self = cycle;
	expect(checkStateApproval(cycle, f.request, f.context)).toMatchObject({
		reason: "json_resource_limit",
	});
});
