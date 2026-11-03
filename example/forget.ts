import { ExampleStateStore } from "./state-store.ts";
import { ExampleExternalAdapter } from "./adapters/external.ts";

/** The host forgets derived state and unsent/retained external text in one writer transaction. */
export function forgetCollaborationSources(
	store: ExampleStateStore,
	external: ExampleExternalAdapter,
	sessionId: string,
	refs: ReadonlySet<string>,
	sourceRevision: number,
) {
	if (store.db !== external.db) throw new Error("shared_writer_required");
	return store.db
		.transaction(() => {
			const state = store.forget(sessionId, refs, sourceRevision);
			external.forgetSources(refs);
			return state;
		})
		.immediate();
}
