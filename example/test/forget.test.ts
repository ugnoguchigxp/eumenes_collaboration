import { expect, test } from "bun:test";
import { ExampleStateStore } from "../state-store.ts";
import {
	ExampleExternalAdapter,
	type ExternalStatus,
} from "../adapters/external.ts";
import { forgetCollaborationSources } from "../forget.ts";
import { initial } from "../../test/state.fixture.ts";

test("a failed external redaction rolls back state forgetting and its revocation ledger", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(initial(), 2);
		const external = new ExampleExternalAdapter(
			store.db,
			{
				async deliver() {
					return "queued";
				},
				async stop() {
					return "unconfirmed";
				},
			},
			{
				sessionId: "s",
				target: () => undefined,
				grant: () => undefined,
				epoch: () => 2,
				source: () => undefined,
			},
		);
		store.db.query("INSERT INTO example_external_requests VALUES(?,?,?)").run(
			"r",
			"digest",
			JSON.stringify({
				request: {
					requestId: "r",
					collaborationSessionId: "s",
					sourceRefs: ["u1"],
					prompt: "原文",
				},
				status: "queued",
				independentlyVerified: false,
			}),
		);
		store.db.exec(
			"CREATE TRIGGER refuse_forget BEFORE UPDATE ON example_external_requests BEGIN SELECT RAISE(ABORT,'injected'); END",
		);
		expect(() =>
			forgetCollaborationSources(store, external, "s", new Set(["u1"]), 2),
		).toThrow("injected");
		expect(store.read("s")).toEqual(initial());
		expect(
			store.db.query("SELECT * FROM example_revoked_sources").all(),
		).toHaveLength(0);
		store.db.exec("DROP TRIGGER refuse_forget");
		forgetCollaborationSources(store, external, "s", new Set(["u1"]), 2);
		expect(store.read("s")).toMatchObject({ facts: [] });
		expect(external.read("r")).toMatchObject({
			status: "cancelled",
			request: { prompt: "", sourceRefs: [] },
		});
	} finally {
		store.close();
	}
});

test("forgetting reports each affected external request and whether it may still be running", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(initial(), 2);
		const external = new ExampleExternalAdapter(
			store.db,
			{
				async deliver() {
					return "queued";
				},
				async stop() {
					return "unconfirmed";
				},
			},
			{
				sessionId: "s",
				target: () => undefined,
				grant: () => undefined,
				epoch: () => 2,
				source: () => undefined,
			},
		);
		const insert = (id: string, status: string, sourceRef: string) =>
			store.db.query("INSERT INTO example_external_requests VALUES(?,?,?)").run(
				id,
				"digest",
				JSON.stringify({
					request: {
						requestId: id,
						collaborationSessionId: "s",
						sourceRefs: [sourceRef],
						prompt: "原文",
					},
					status,
					independentlyVerified: false,
				}),
			);
		const needing: ExternalStatus[] = [
			"delivered",
			"started",
			"waiting",
			"stopping",
			"unknown",
		];
		for (const status of needing) insert(status, status, "u1");
		for (const status of ["queued", "completed", "stopped", "cancelled"])
			insert(status, status, "u1");
		insert("unrelated", "started", "u9");

		const result = forgetCollaborationSources(
			store,
			external,
			"s",
			new Set(["u1"]),
			2,
		);
		expect(result.orphaned).toEqual([]);
		expect(result.state).toMatchObject({ facts: [] });
		const byId = Object.fromEntries(result.affected.map((a) => [a.id, a]));
		expect(Object.keys(byId).sort()).toEqual(
			[...needing, "queued", "completed", "stopped", "cancelled"].sort(),
		);
		for (const status of needing)
			expect(byId[status]).toEqual({
				id: status,
				previousStatus: status,
				needsStop: true,
			});
		for (const status of [
			"queued",
			"completed",
			"stopped",
			"cancelled",
		] as const)
			expect(byId[status]).toEqual({
				id: status,
				previousStatus: status,
				needsStop: false,
			});
		expect(external.read("queued")?.status).toBe("cancelled");
		expect(external.read("started")?.status).toBe("unknown");
		expect(external.read("started")).toMatchObject({
			request: { prompt: "", sourceRefs: [] },
		});
		expect(external.read("unrelated")?.request.prompt).toBe("原文");
		// Nothing is stopped automatically.
	} finally {
		store.close();
	}
});
