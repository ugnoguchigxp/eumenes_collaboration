import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { ExampleExternalAdapter } from "../adapters/external.ts";
import { host, request } from "./crash.fixture.ts";
test("real process exit during delivery and stop becomes reconcilable without replay", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-crash-"));
	try {
		for (const mode of ["send", "stop"]) {
			const path = join(dir, mode + ".sqlite");
			const child = Bun.spawnSync([
				"bun",
				join(import.meta.dir, "crash.fixture.ts"),
				path,
				mode,
			]);
			expect(child.exitCode).toBe(mode === "send" ? 17 : 18);
			const db = new Database(path);
			let sends = 0;
			try {
				const a = new ExampleExternalAdapter(
					db,
					{
						async deliver() {
							sends++;
							return "delivered";
						},
						async stop() {
							return "unconfirmed";
						},
					},
					host,
				);
				const prior = a.read("r")!;
				expect(prior.status).toBe(mode === "send" ? "queued" : "stopping");
				expect((await a.reconcile("r", prior.attempt ?? 0)).status).toBe(
					"unknown",
				);
				expect((await a.submit(request)).status).toBe("unknown");
				expect(sends).toBe(0);
				expect((await a.stop("r")).status).toBe("unknown");
			} finally {
				db.close();
			}
		}
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
