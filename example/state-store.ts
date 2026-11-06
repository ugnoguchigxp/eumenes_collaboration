import { Database } from "bun:sqlite";
import {
	collaborationStateSchema,
	forgetStateSources,
	proposeStateUpdate,
	withinJsonLimits,
	type CollaborationState,
	type StateHostContext,
} from "eumenes-collaboration";
import {
	ensureSourceRevocations,
	revokedSources,
	revokeSources,
} from "./source-revocations.ts";

const isBusy = (error: unknown) =>
	error instanceof Error &&
	(String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY") ||
		/database (table )?is locked/i.test(error.message));

/** Example-only storage. Product dialogue owns its own migrations and writer. */
export class ExampleStateStore {
	readonly db: Database;
	constructor(path: string, busyTimeoutMs = 5000) {
		if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 0)
			throw new Error("busy_timeout_invalid");
		this.db = new Database(path, { create: true, strict: true });
		try {
			this.db.exec(
				`PRAGMA busy_timeout=${busyTimeoutMs}; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;`,
			);
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
							"CREATE TABLE example_sessions(id TEXT PRIMARY KEY, epoch INTEGER NOT NULL, state TEXT NOT NULL); CREATE TABLE example_receipts(id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES example_sessions(id), digest TEXT NOT NULL, revision INTEGER NOT NULL); INSERT INTO example_migrations VALUES(1)",
						);
					}
					ensureSourceRevocations(this.db);
				})
				.immediate();
		} catch (error) {
			this.db.close();
			throw isBusy(error) ? new Error("state_store_busy") : error;
		}
	}
	/** Runs one writer transaction; a lock that outlasts `busy_timeout` fails with `state_store_busy` and writes nothing. */
	private write<T>(body: () => T): T {
		try {
			return this.db.transaction(body).immediate();
		} catch (error) {
			throw isBusy(error) ? new Error("state_store_busy") : error;
		}
	}
	initialize(state: CollaborationState, epoch: number) {
		if (!Number.isSafeInteger(epoch) || epoch < 0)
			throw new Error("epoch_invalid");
		if (!withinJsonLimits(state)) throw new Error("json_resource_limit");
		const checked = collaborationStateSchema.parse(state);
		return this.write(() => {
			const row = this.db
				.query<{ state: string }, [string]>(
					"SELECT state FROM example_sessions WHERE id=?",
				)
				.get(checked.sessionId);
			if (row) return JSON.parse(row.state) as unknown;
			const revoked = revokedSources(this.db, checked.sessionId);
			if (
				checked.facts.some((f) => f.sourceRefs.some((ref) => revoked.has(ref)))
			)
				throw new Error("source_invalid");
			this.db
				.query("INSERT INTO example_sessions VALUES(?,?,?)")
				.run(checked.sessionId, epoch, JSON.stringify(checked));
			return this.read(checked.sessionId);
		});
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
		if (!withinJsonLimits(proposal))
			return { ok: false as const, reason: "json_resource_limit" };
		return this.write(() => {
			const row = this.db
				.query<{ epoch: number }, [string]>(
					"SELECT epoch FROM example_sessions WHERE id=?",
				)
				.get(id);
			if (!row || host.sessionId !== id || row.epoch !== host.epoch)
				return { ok: false as const, reason: "session_changed" };
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
				if ((proposal as { epoch?: unknown } | null)?.epoch !== host.epoch)
					return { ok: false as const, reason: "session_changed" };
				return {
					ok: true as const,
					replay: true,
					revision: receipt.revision,
				};
			}
			const revoked = revokedSources(this.db, id);
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
		});
	}
	/** Forget in the writer's transaction; `orphaned` names retracted facts whose replacements were forgotten. */
	forget(id: string, refs: ReadonlySet<string>, sourceRevision: number) {
		return this.write(() => {
			const saved = this.read(id) as { revision?: unknown } | null;
			const result = forgetStateSources(saved, {
				sessionId: id,
				expectedRevision:
					typeof saved?.revision === "number" ? saved.revision : -1,
				invalidRefs: refs,
				sourceRevision,
			});
			revokeSources(this.db, id, refs);
			this.db
				.query("UPDATE example_sessions SET state=? WHERE id=?")
				.run(JSON.stringify(result.state), id);
			return result;
		});
	}
	close() {
		this.db.close();
	}
}
