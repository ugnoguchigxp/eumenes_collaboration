import { ExampleStateStore } from "./state-store.ts";
import { ExampleExternalAdapter } from "./adapters/external.ts";

const isBusy = (error: unknown) =>
	error instanceof Error &&
	(String((error as { code?: unknown }).code).startsWith("SQLITE_BUSY") ||
		/database (table )?is locked/i.test(error.message));

/**
 * The host forgets derived state and unsent/retained external text in one writer transaction.
 * `orphaned` lists retracted facts that lost their replacement; `affected` lists external requests
 * whose retained text was redacted. Requests with `needsStop` may still be running remotely; the host decides.
 */
export function forgetCollaborationSources(
	store: ExampleStateStore,
	external: ExampleExternalAdapter,
	sessionId: string,
	refs: ReadonlySet<string>,
	sourceRevision: number,
) {
	if (store.db !== external.db) throw new Error("shared_writer_required");
	try {
		return store.db
			.transaction(() => {
				const { state, orphaned } = store.forget(
					sessionId,
					refs,
					sourceRevision,
				);
				const { affected } = external.forgetSources(sessionId, refs);
				return { state, orphaned, affected };
			})
			.immediate();
	} catch (error) {
		throw isBusy(error) ? new Error("state_store_busy") : error;
	}
}
