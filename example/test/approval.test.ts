import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExampleStateStore } from "../state-store.ts";
import { initial, host, proposal } from "../../test/state.fixture.ts";

test("explicit review persists across restart; a correction cannot use the old approval", async () => {
	const dir = await mkdtemp(join(tmpdir(), "state-approval-"));
	let store = new ExampleStateStore(join(dir, "state.sqlite"));
	const h = host(),
		request = { factId: "prior", approvalRef: "review", expectedRevision: 0 };
	try {
		store.initialize(initial(), h.epoch);
		expect(store.checkApproval("s", request, h).ok).toBe(false);
		store.recordApproval(
			"s",
			{ ...request, ref: "review", sourceRef: "u2" },
			h,
		);
		store.close();
		store = new ExampleStateStore(join(dir, "state.sqlite"));
		expect(store.checkApproval("s", request, h).ok).toBe(true);
		expect(store.adopt("s", "correction", proposal(), h).ok).toBe(true);
		expect(
			store.checkApproval("s", { ...request, expectedRevision: 1 }, h).ok,
		).toBe(false);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("forgetting approval or fact sources erases retained review text and prevents reissuance from a stale registry", () => {
	for (const source of ["u1", "u2"]) {
		const store = new ExampleStateStore(":memory:");
		const h = host();
		try {
			store.initialize(initial(), h.epoch);
			store.recordApproval(
				"s",
				{
					ref: "review",
					factId: "prior",
					sourceRef: "u2",
					expectedRevision: 0,
				},
				h,
			);
			store.forget("s", new Set([source]), 2);
			expect(
				store.db
					.query("SELECT count(*) AS n FROM example_state_approvals")
					.get(),
			).toEqual({ n: 0 });
			expect(
				store.checkApproval(
					"s",
					{ factId: "prior", approvalRef: "review", expectedRevision: 1 },
					{ ...h, sourceRevision: 2 },
				).ok,
			).toBe(false);
			expect(() =>
				store.recordApproval(
					"s",
					{
						ref: "again",
						factId: "prior",
						sourceRef: "u2",
						expectedRevision: 1,
					},
					{ ...h, sourceRevision: 2 },
				),
			).toThrow();
		} finally {
			store.close();
		}
	}
});
