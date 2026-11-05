import { Database } from "bun:sqlite";
import {
	collaborationStateSchema,
	forgetStateSources,
	proposeStateUpdate,
	withinJsonLimits,
	type CollaborationState,
	type StateHostContext,
} from "eumenes-collaboration";

/** Example-only storage. Product dialogue owns its own migrations and writer. */
export class ExampleStateStore {
	readonly db: Database;
	constructor(path: string) {
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec("PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;");
		this.db
			.transaction(() => {
				this.db.exec(
					"CREATE TABLE IF NOT EXISTS example_migrations(version INTEGER PRIMARY KEY)",
				);
				if (
					!this.db
						.query("SELECT version FROM example_migrations WHERE version=1")
						.get()
				) {
					this.db.exec(
						"CREATE TABLE example_sessions(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE example_receipts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES example_sessions(id), digest TEXT NOT NULL, revision INTEGER NOT NULL); CREATE TABLE example_revoked_sources(session_id TEXT NOT NULL REFERENCES example_sessions(id), ref TEXT NOT NULL, PRIMARY KEY(session_id,ref)); INSERT INTO example_migrations VALUES(1)",
					);
				}
			})
			.immediate();
	}
	initialize(state: CollaborationState, epoch: number) {
		if (!withinJsonLimits(state)) throw new Error("json_resource_limit");
		const checked = collaborationStateSchema.parse(state);
		this.db
			.query(
				"INSERT INTO example_sessions VALUES(?,?,?) ON CONFLICT(id) DO NOTHING",
			)
			.run(checked.sessionId, epoch, JSON.stringify(checked));
		return this.read(checked.sessionId);
	}
	read(id: string): unknown {
		const row = this.db
			.query<{ state: string }, [string]>(
				"SELECT state FROM example_sessions WHERE id=?",
			)
			.get(id);
		return row ? JSON.parse(row.state) : null;
	}
	adopt(
		id: string,
		operationId: string,
		proposal: unknown,
		host: StateHostContext,
	) {
		return this.db
			.transaction(() => {
				const digest = new Bun.CryptoHasher("sha256")
					.update(JSON.stringify(proposal))
					.digest("hex");
				const receipt = this.db
					.query<
						{ session_id: string; digest: string; revision: number },
						[string]
					>("SELECT * FROM example_receipts WHERE id=?")
					.get(operationId);
				if (receipt) {
					if (receipt.session_id !== id || receipt.digest !== digest)
						return {
							ok: false as const,
							reason: "operation_identity_conflict",
						};
					return {
						ok: true as const,
						replay: true,
						revision: receipt.revision,
					};
				}
				const row = this.db
					.query<{ epoch: number }, [string]>(
						"SELECT epoch FROM example_sessions WHERE id=?",
					)
					.get(id);
				if (!row || host.sessionId !== id || row.epoch !== host.epoch)
					return { ok: false as const, reason: "session_changed" };
				const revoked = new Set(
					this.db
						.query<{ ref: string }, [string]>(
							"SELECT ref FROM example_revoked_sources WHERE session_id=?",
						)
						.all(id)
						.map((row) => row.ref),
				);
				const checked = proposeStateUpdate(this.read(id), proposal, {
					...host,
					sources: host.sources.map((source) => ({
						...source,
						active: source.active && !revoked.has(source.ref),
					})),
				});
				if (!checked.ok) return checked;
				this.db
					.query("UPDATE example_sessions SET state=? WHERE id=?")
					.run(JSON.stringify(checked.state), id);
				this.db
					.query("INSERT INTO example_receipts VALUES(?,?,?,?)")
					.run(operationId, id, digest, checked.state.revision);
				return {
					ok: true as const,
					replay: false,
					revision: checked.state.revision,
				};
			})
			.immediate();
	}
	forget(id: string, refs: ReadonlySet<string>, sourceRevision: number) {
		return this.db
			.transaction(() => {
				const state = forgetStateSources(this.read(id), refs, sourceRevision);
				for (const ref of refs)
					this.db
						.query("INSERT OR IGNORE INTO example_revoked_sources VALUES(?,?)")
						.run(id, ref);
				this.db
					.query("UPDATE example_sessions SET state=? WHERE id=?")
					.run(JSON.stringify(state), id);
				return state;
			})
			.immediate();
	}
	close() {
		this.db.close();
	}
}
