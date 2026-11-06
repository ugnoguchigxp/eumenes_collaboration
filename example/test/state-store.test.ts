import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExampleStateStore } from "../state-store.ts";
import { host, initial, proposal } from "../../test/state.fixture.ts";

test("SQLite reopen/migration preserves state; operation receipts are idempotent and atomic", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-state-"));
	let store = new ExampleStateStore(join(dir, "state.sqlite"));
	try {
		store.initialize(initial(), 2);
		expect(store.adopt("s", "op", proposal(), host())).toEqual({
			ok: true,
			replay: false,
			revision: 1,
		});
		store.close();
		store = new ExampleStateStore(join(dir, "state.sqlite"));
		expect(store.adopt("s", "op", proposal(), host())).toEqual({
			ok: true,
			replay: true,
			revision: 1,
		});
		expect(
			store.adopt("s", "op", { ...proposal(), epoch: 99 }, host()),
		).toEqual({ ok: false, reason: "operation_identity_conflict" });
		expect(store.adopt("s", "other", proposal(), host())).toEqual({
			ok: false,
			reason: "state_revision_conflict",
		});
		const before = store.read("s");
		store.db.exec(
			"CREATE TRIGGER fail_receipt BEFORE INSERT ON example_receipts BEGIN SELECT RAISE(ABORT,'injected'); END",
		);
		expect(() =>
			store.adopt("s", "fail", { ...proposal(), expectedRevision: 1 }, host()),
		).toThrow("injected");
		expect(store.read("s")).toEqual(before);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("forgetting survives reopen and an older host registry cannot resurrect its sources", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-forget-"));
	let store = new ExampleStateStore(join(dir, "state.sqlite"));
	try {
		store.initialize(initial(), 2);
		store.forget("s", new Set(["u1"]), 2);
		store.close();
		store = new ExampleStateStore(join(dir, "state.sqlite"));
		const p = {
			...proposal(),
			expectedRevision: 1,
			sourceRevision: 2,
			upserts: [initial().facts[0]!],
		};
		expect(
			store.adopt("s", "new", p, { ...host(), sourceRevision: 2 }),
		).toEqual({ ok: false, reason: "source_invalid" });
		expect(store.read("s")).toMatchObject({ facts: [], revision: 1 });
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("an unsupported persisted schema is preserved across restart and attempted initialization", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(initial(), 2);
		const unknown = { ...initial(), stateSchemaVersion: 99 };
		store.db
			.query("UPDATE example_sessions SET state=? WHERE id='s'")
			.run(JSON.stringify(unknown));
		expect(store.initialize(initial(), 2)).toEqual(unknown);
		expect(store.adopt("s", "new", proposal(), host())).toEqual({
			ok: false,
			reason: "state_schema_unsupported_or_invalid",
		});
		expect(store.read("s")).toEqual(unknown);
	} finally {
		store.close();
	}
});

test("two SQLite connections cannot observe or publish a partial state/receipt transaction", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-contention-"));
	const left = new ExampleStateStore(join(dir, "state.sqlite"));
	const right = new ExampleStateStore(join(dir, "state.sqlite"), 20);
	try {
		left.initialize(initial(), 2);
		left.db.exec("BEGIN IMMEDIATE");
		expect(left.adopt("s", "winner", proposal(), host()).ok).toBe(true);
		expect(right.read("s")).toEqual(initial());
		expect(right.db.query("SELECT * FROM example_receipts").all()).toEqual([]);
		expect(() => right.adopt("s", "contender", proposal(), host())).toThrow(
			"state_store_busy",
		);
		left.db.exec("COMMIT");
		expect(right.read("s")).toMatchObject({ revision: 1 });
		expect(right.db.query("SELECT id FROM example_receipts").all()).toEqual([
			{ id: "winner" },
		]);
		expect(right.adopt("s", "contender", proposal(), host())).toEqual({
			ok: false,
			reason: "state_revision_conflict",
		});
		expect(right.adopt("s", "winner", proposal(), host())).toMatchObject({
			ok: true,
			replay: true,
			revision: 1,
		});
	} finally {
		left.close();
		right.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("initialization cannot persist an oversized state that subsequent adoption cannot read", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		const state = initial();
		state.facts[0]!.value = "x".repeat(2100000);
		expect(() => store.initialize(state, 2)).toThrow("json_resource_limit");
		expect(store.db.query("SELECT * FROM example_sessions").all()).toEqual([]);
	} finally {
		store.close();
	}
});

test("receipt replay checks the current session and epoch before reporting success", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(initial(), 2);
		expect(store.adopt("s", "op", proposal(), host()).ok).toBe(true);
		expect(
			store.adopt("s", "op", proposal(), { ...host(), sessionId: "other" }),
		).toEqual({ ok: false, reason: "session_changed" });
		store.db.query("UPDATE example_sessions SET epoch=3 WHERE id='s'").run();
		expect(store.adopt("s", "op", proposal(), { ...host(), epoch: 3 }).ok).toBe(
			false,
		);
	} finally {
		store.close();
	}
});

test("the writer rejects cyclic proposals before serialization and leaves no receipt", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		store.initialize(initial(), 2);
		const p: Record<string, unknown> = {};
		p.self = p;
		expect(store.adopt("s", "cycle", p, host())).toEqual({
			ok: false,
			reason: "json_resource_limit",
		});
		expect(store.read("s")).toEqual(initial());
		expect(store.db.query("SELECT * FROM example_receipts").all()).toEqual([]);
	} finally {
		store.close();
	}
});

test("invalid epochs cannot initialize a session that no valid proposal could update", () => {
	const store = new ExampleStateStore(":memory:");
	try {
		for (const epoch of [NaN, Infinity, -1, 1.5])
			expect(() => store.initialize(initial(), epoch)).toThrow("epoch_invalid");
		expect(store.read("s")).toBeNull();
	} finally {
		store.close();
	}
});

test("existing version-one databases keep their receipts and foreign-key revocations", async () => {
	const { Database } = await import("bun:sqlite");
	const dir = await mkdtemp(join(tmpdir(), "collaboration-legacy-"));
	const path = join(dir, "state.sqlite");
	const old = new Database(path);
	const saved = { ...initial(), revision: 1, sourceRevision: 2, facts: [] };
	old.exec(
		"PRAGMA foreign_keys=ON; CREATE TABLE example_migrations(version INTEGER PRIMARY KEY); INSERT INTO example_migrations VALUES(1); CREATE TABLE example_sessions(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL,state TEXT NOT NULL); CREATE TABLE example_receipts(id TEXT PRIMARY KEY,session_id TEXT NOT NULL REFERENCES example_sessions(id),digest TEXT NOT NULL,revision INTEGER NOT NULL); CREATE TABLE example_revoked_sources(session_id TEXT NOT NULL REFERENCES example_sessions(id),ref TEXT NOT NULL,PRIMARY KEY(session_id,ref));",
	);
	old
		.query("INSERT INTO example_sessions VALUES(?,?,?)")
		.run("s", 2, JSON.stringify(saved));
	old.query("INSERT INTO example_revoked_sources VALUES(?,?)").run("s", "u1");
	old
		.query("INSERT INTO example_receipts VALUES(?,?,?,?)")
		.run("historic", "s", "digest", 1);
	old.close();
	const store = new ExampleStateStore(path);
	try {
		expect(store.initialize(initial(), 2)).toEqual(saved);
		expect(store.db.query("SELECT id FROM example_receipts").all()).toEqual([
			{ id: "historic" },
		]);
		expect(
			store.db.query("PRAGMA foreign_key_list(example_revoked_sources)").all()
				.length,
		).toBe(1);
		const p = {
			...proposal(),
			expectedRevision: 1,
			sourceRevision: 2,
			upserts: [initial().facts[0]!],
			removals: [],
		};
		expect(
			store.adopt("s", "stale", p, { ...host(), sourceRevision: 2 }),
		).toEqual({ ok: false, reason: "source_invalid" });
		p.upserts = [{ ...initial().facts[0]!, sourceRefs: ["u2"] }];
		expect(
			store.adopt("s", "fresh", p, { ...host(), sourceRevision: 2 }).ok,
		).toBe(true);
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});
