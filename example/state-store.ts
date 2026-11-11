import { Database } from "bun:sqlite";
import {
	collaborationStateSchema,
	forgetStateSources,
	proposeStateUpdate,
	withinJsonLimits,
	checkStateApproval,
	type StateApproval,
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
					this.db.exec(
						"CREATE TABLE IF NOT EXISTS example_state_approvals(ref TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES example_sessions(id), body TEXT NOT NULL); INSERT OR IGNORE INTO example_migrations VALUES(2)",
					);
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
	/** Host-only entry for an authenticated review interaction. Never expose this as a model tool. */
	recordApproval(
		id: string,
		input: {
			ref: string;
			sourceRef: string;
			factId: string;
			expectedRevision: number;
		},
		host: StateHostContext,
	) {
		return this.write(() => {
			const state = collaborationStateSchema.parse(this.read(id));
			const row = this.db
				.query<{ epoch: number }, [string]>(
					"SELECT epoch FROM example_sessions WHERE id=?",
				)
				.get(id);
			if (!row || row.epoch !== host.epoch || id !== host.sessionId)
				throw new Error("session_changed");
			const fact = state.facts.find((f) => f.id === input.factId);
			if (!fact) throw new Error("approval_fact_unconfirmed");
			const approval: StateApproval = {
				ref: input.ref,
				sourceRef: input.sourceRef,
				fact: structuredClone(fact),
				work: { ...host.work },
				sessionId: id,
				epoch: host.epoch,
				active: true,
			};
			const revoked = revokedSources(this.db, id);
			const checked = checkStateApproval(
				state,
				{
					factId: input.factId,
					approvalRef: input.ref,
					expectedRevision: input.expectedRevision,
				},
				{
					...host,
					sources: host.sources.map((s) => ({
						...s,
						active: s.active && !revoked.has(s.ref),
					})),
					approvals: [approval],
				},
			);
			if (!checked.ok) throw new Error(checked.reason);
			const previous = this.db
				.query<{ body: string; session_id: string }, [string]>(
					"SELECT body,session_id FROM example_state_approvals WHERE ref=?",
				)
				.get(input.ref);
			const body = JSON.stringify(approval);
			if (previous) {
				if (previous.session_id !== id || previous.body !== body)
					throw new Error("approval_identity_conflict");
				return checked;
			}
			this.db
				.query("INSERT INTO example_state_approvals VALUES(?,?,?)")
				.run(input.ref, id, body);
			return checked;
		});
	}
	/** Revalidate in the protected operation's writer transaction, not once when constructing its prompt. */
	checkApproval(
		id: string,
		input: { factId: string; approvalRef: string; expectedRevision: number },
		host: StateHostContext,
	) {
		const row = this.db
			.query<{ epoch: number }, [string]>(
				"SELECT epoch FROM example_sessions WHERE id=?",
			)
			.get(id);
		if (!row || row.epoch !== host.epoch || id !== host.sessionId)
			return { ok: false as const, reason: "session_changed" };
		const revoked = revokedSources(this.db, id);
		const approvals = this.db
			.query<{ body: string }, [string]>(
				"SELECT body FROM example_state_approvals WHERE session_id=?",
			)
			.all(id)
			.map((row) => JSON.parse(row.body) as StateApproval);
		return checkStateApproval(this.read(id), input, {
			...host,
			sources: host.sources.map((s) => ({
				...s,
				active: s.active && !revoked.has(s.ref),
			})),
			approvals,
		});
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
			for (const row of this.db
				.query<{ ref: string; body: string }, [string]>(
					"SELECT ref,body FROM example_state_approvals WHERE session_id=?",
				)
				.all(id)) {
				const approval = JSON.parse(row.body) as StateApproval;
				if (
					refs.has(approval.sourceRef) ||
					approval.fact.sourceRefs.some((ref) => refs.has(ref))
				)
					this.db
						.query("DELETE FROM example_state_approvals WHERE ref=?")
						.run(row.ref);
			}
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
