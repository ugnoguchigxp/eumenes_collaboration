import { Database } from "bun:sqlite";
/** Shared, durable USD reservation ledger. Unknown outcomes retain their full reservation. */
export class ApiBudget {
	readonly db: Database;
	constructor(
		path: string,
		readonly limitUsd: number,
	) {
		if (!Number.isFinite(limitUsd) || limitUsd <= 0 || limitUsd > 10)
			throw new Error("api_budget_invalid");
		this.db = new Database(path, { create: true, strict: true });
		this.db.exec(
			"PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS api_calls(id TEXT PRIMARY KEY, provider TEXT NOT NULL, reserved REAL NOT NULL, cost REAL, status TEXT NOT NULL, metadata TEXT); CREATE TABLE IF NOT EXISTS api_budget(id INTEGER PRIMARY KEY CHECK(id=1), cap REAL NOT NULL)",
		);
		this.db.query("INSERT OR IGNORE INTO api_budget VALUES(1,?)").run(limitUsd);
		const row = this.db
			.query<{ cap: number }, []>("SELECT cap FROM api_budget WHERE id=1")
			.get()!;
		if (row.cap !== limitUsd) {
			this.db.close();
			throw new Error("api_budget_identity_conflict");
		}
	}
	reserve(provider: string, ceiling: number) {
		return this.db
			.transaction(() => {
				if (!Number.isFinite(ceiling) || ceiling <= 0)
					throw new Error("api_reservation_invalid");
				if (this.used() + ceiling > this.limitUsd)
					throw new Error("api_budget_exhausted");
				const id = crypto.randomUUID();
				this.db
					.query(
						"INSERT INTO api_calls(id,provider,reserved,status) VALUES(?,?,?,?)",
					)
					.run(id, provider, ceiling, "pending");
				return id;
			})
			.immediate();
	}
	settle(id: string, cost: number, metadata: Record<string, unknown>) {
		this.db
			.transaction(() => {
				const call = this.db
					.query<{ reserved: number; status: string }, [string]>(
						"SELECT reserved,status FROM api_calls WHERE id=?",
					)
					.get(id);
				if (
					!call ||
					call.status !== "pending" ||
					!Number.isFinite(cost) ||
					cost < 0 ||
					cost > call.reserved
				)
					throw new Error("api_cost_untrusted");
				this.db
					.query("UPDATE api_calls SET cost=?,status=?,metadata=? WHERE id=?")
					.run(cost, "estimated", JSON.stringify(metadata), id);
			})
			.immediate();
	}
	used() {
		return this.db
			.query<{ n: number }, []>(
				"SELECT coalesce(sum(coalesce(cost,reserved)),0) AS n FROM api_calls",
			)
			.get()!.n;
	}
	summary() {
		return {
			capUsd: this.limitUsd,
			accountedUsd: this.used(),
			calls: this.db
				.query(
					"SELECT provider,status,count(*) AS calls,sum(cost) AS estimatedCostUsd,sum(CASE WHEN cost IS NULL THEN reserved ELSE 0 END) AS unknownReservedUsd FROM api_calls GROUP BY provider,status",
				)
				.all(),
		};
	}
	close() {
		this.db.close();
	}
}
