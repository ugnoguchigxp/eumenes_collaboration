import { expect, test } from "bun:test";
import { ExampleStateStore } from "../state-store.ts";
import { ExampleExternalAdapter } from "../adapters/external.ts";
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
