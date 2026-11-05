import type { Database } from "bun:sqlite";

/** One durable revocation registry, shared by state adoption and external effects. */
export function ensureSourceRevocations(db: Database) {
	db.exec(
		"CREATE TABLE IF NOT EXISTS example_revoked_sources(session_id TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(session_id,ref))",
	);
}
export function revokedSources(db: Database, sessionId: string): Set<string> {
	return new Set(
		db
			.query<{ ref: string }, [string]>(
				"SELECT ref FROM example_revoked_sources WHERE session_id=?",
			)
			.all(sessionId)
			.map((row) => row.ref),
	);
}
export function revokeSources(
	db: Database,
	sessionId: string,
	refs: ReadonlySet<string>,
) {
	for (const ref of refs)
		db.query("INSERT OR IGNORE INTO example_revoked_sources VALUES(?,?)").run(
			sessionId,
			ref,
		);
}
