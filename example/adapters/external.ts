import { Database } from "bun:sqlite";
import { z } from "zod";
import { withinJsonLimits } from "eumenes-collaboration";
import {
	ensureSourceRevocations,
	revokedSources,
	revokeSources,
} from "../source-revocations.ts";

const ref = z.string().min(1).max(256);
const revision = z.number().int().nonnegative();
const externalEventSchema = z.strictObject({
	id: ref,
	requestId: ref,
	generation: revision,
	kind: z.enum(["started", "waiting", "completed"]),
	question: z
		.strictObject({
			id: ref,
			kind: z.enum(["question", "permission", "authentication"]),
			prompt: z.string().min(1).max(16000),
		})
		.optional(),
	report: z.string().max(16000).optional(),
});
const externalAnswerSchema = z.strictObject({
	requestId: ref,
	questionId: ref,
	generation: revision,
	text: z.string(),
	sourceRef: ref,
});
export const externalRequestSchema = z.strictObject({
	requestId: ref,
	collaborationSessionId: ref,
	epoch: revision,
	requestRevision: revision,
	projectRef: ref,
	externalSessionRef: ref,
	generation: revision,
	prompt: z.string().min(1).max(100000),
	sourceRefs: z.array(ref).min(1),
	authorityRef: ref,
});
export type ExternalRequest = z.infer<typeof externalRequestSchema>;
export type ExternalTarget = {
	projectRef: string;
	externalSessionRef: string;
	generation: number;
	inputOwner: "host" | "user";
};
export type ExternalGrant = {
	ref: string;
	requestDigest: string;
	projectRef: string;
	externalSessionRef: string;
	generation: number;
	requestRevision: number;
};
export type ExternalQuestion = {
	id: string;
	kind: "question" | "permission" | "authentication";
	prompt: string;
	answered: boolean;
};
export type ExternalStatus =
	| "queued"
	| "delivered"
	| "started"
	| "waiting"
	| "completed"
	| "stopping"
	| "stopped"
	| "cancelled"
	| "unknown";
export type ExternalRecord = {
	request: ExternalRequest;
	status: ExternalStatus;
	question?: ExternalQuestion;
	reportedResult?: string;
	independentlyVerified: boolean;
	forgotten?: boolean;
	answer?: {
		digest: string;
		status: "pending" | "sent" | "unknown";
		sourceRef?: string;
	};
	/** Persisted fencing token; old async replies may not overwrite reconciliation. */
	attempt?: number;
	/**
	 * The host's intent to stop, set by the first `stop()` and never cleared. `status` stays the last
	 * observed external state; a stop that could not be confirmed leaves `status` as `unknown`/observed
	 * and the host may call `stop()` again explicitly. Nothing is resent automatically.
	 */
	stopRequested?: { attempt: number };
};
/**
 * `inconclusive`: the inspection gave no conclusive observation, so the recorded status was kept.
 * `stopPending`: a stop was requested and the request has not ended; the host decides whether to call stop again.
 */
export type ExternalReconciliation = ExternalRecord & {
	inspection?: "inconclusive";
	stopPending?: true;
};
const needsStop = (status: ExternalStatus) =>
	["delivered", "started", "waiting", "stopping", "unknown"].includes(status);
const phase = { queued: 0, delivered: 1, started: 2 } as const;
export interface ExternalPort {
	inspect?(
		target: ExternalTarget,
		requestId: string,
	): Promise<{
		status: "delivered" | "started" | "completed" | "stopped" | "unknown";
		answer?: "sent" | "unknown";
	}>;
	deliver(request: ExternalRequest): Promise<"queued" | "delivered">;
	answerQuestion?(
		target: ExternalTarget,
		questionId: string,
		text: string,
	): Promise<"sent" | "unknown">;
	stop(
		target: ExternalTarget,
		requestId: string,
	): Promise<"confirmed" | "unconfirmed">;
}
export const requestDigest = (
	request: Omit<ExternalRequest, "authorityRef">,
) => {
	if (!withinJsonLimits(request)) throw new Error("json_resource_limit");
	return new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify(
				externalRequestSchema.omit({ authorityRef: true }).parse(request),
			),
		)
		.digest("hex");
};
const jsonDigest = (value: unknown) =>
	new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (status: ExternalStatus) =>
	["completed", "stopped", "cancelled"].includes(status);

/** Example lifecycle ledger. Targets, grants, epochs and sources are supplied by the host. */
export class ExampleExternalAdapter {
	/**
	 * Requests with a port call in flight in this process. Reconciling one would advance its attempt and discard
	 * the live call's result, so it is refused until the call returns; after a crash the set starts empty.
	 */
	private readonly inFlight = new Set<string>();
	private async withPortCall<T>(id: string, call: () => Promise<T>) {
		this.inFlight.add(id);
		try {
			return await call();
		} finally {
			this.inFlight.delete(id);
		}
	}
	constructor(
		readonly db: Database,
		readonly port: ExternalPort,
		readonly host: {
			sessionId: string;
			target: (ref: string) => ExternalTarget | undefined;
			grant: (ref: string) => ExternalGrant | undefined;
			epoch: (session: string) => number | undefined;
			source: (
				ref: string,
			) =>
				| { active: boolean; kind: "user" | "assistant" | "observation" }
				| undefined;
		},
	) {
		ensureSourceRevocations(db);
		db.exec(
			"CREATE TABLE IF NOT EXISTS example_external_requests(id TEXT PRIMARY KEY, digest TEXT NOT NULL, body TEXT NOT NULL); CREATE TABLE IF NOT EXISTS example_external_events(id TEXT PRIMARY KEY,digest TEXT NOT NULL); CREATE TABLE IF NOT EXISTS example_external_questions(request_id TEXT NOT NULL,id TEXT NOT NULL,digest TEXT NOT NULL,PRIMARY KEY(request_id,id))",
		);
	}
	read(id: string): ExternalRecord | null {
		const row = this.db
			.query<{ body: string }, [string]>(
				"SELECT body FROM example_external_requests WHERE id=?",
			)
			.get(id);
		if (!row) return null;
		const record: ExternalRecord = JSON.parse(row.body);
		return record.request.collaborationSessionId === this.host.sessionId
			? record
			: null;
	}
	private save(record: ExternalRecord) {
		this.db
			.query("UPDATE example_external_requests SET body=? WHERE id=?")
			.run(JSON.stringify(record), record.request.requestId);
	}
	private target(request: ExternalRequest, requireInput = true) {
		const target = this.host.target(request.externalSessionRef);
		if (
			request.collaborationSessionId !== this.host.sessionId ||
			!target ||
			target.externalSessionRef !== request.externalSessionRef ||
			target.projectRef !== request.projectRef ||
			target.generation !== request.generation ||
			(requireInput && target.inputOwner !== "host") ||
			this.host.epoch(request.collaborationSessionId) !== request.epoch
		)
			throw new Error("external_target_changed");
		return Object.freeze({ ...target });
	}
	async submit(value: unknown) {
		if (!withinJsonLimits(value)) throw new Error("json_resource_limit");
		const request = externalRequestSchema.parse(value);
		const { authorityRef, ...frozen } = request;
		const digest = requestDigest(frozen);
		const existing = this.read(request.requestId);
		if (existing) {
			const row = this.db
				.query<{ digest: string }, [string]>(
					"SELECT digest FROM example_external_requests WHERE id=?",
				)
				.get(request.requestId)!;
			if (
				row.digest !== digest ||
				existing.request.authorityRef !== authorityRef
			)
				throw new Error("external_request_identity_conflict");
			return existing;
		}
		this.target(request);
		const revoked = revokedSources(this.db, this.host.sessionId);
		if (
			!request.sourceRefs.every(
				(ref) => this.host.source(ref)?.active && !revoked.has(ref),
			)
		)
			throw new Error("external_source_invalid");
		const grant = this.host.grant(authorityRef);
		if (
			!grant ||
			grant.ref !== authorityRef ||
			grant.requestDigest !== digest ||
			grant.projectRef !== request.projectRef ||
			grant.externalSessionRef !== request.externalSessionRef ||
			grant.generation !== request.generation ||
			grant.requestRevision !== request.requestRevision
		)
			throw new Error("external_authority_invalid");
		const record: ExternalRecord = {
			request,
			status: "queued",
			attempt: 1,
			independentlyVerified: false,
		};
		this.db
			.query("INSERT INTO example_external_requests VALUES(?,?,?)")
			.run(request.requestId, digest, JSON.stringify(record));
		try {
			const status = await this.withPortCall(request.requestId, () =>
				this.port.deliver(request),
			);
			this.target(request);
			const latest = this.read(request.requestId)!;
			if (latest.attempt === record.attempt && latest.status === "queued")
				this.save({ ...latest, status });
		} catch {
			const latest = this.read(request.requestId)!;
			if (
				latest.attempt === record.attempt &&
				!latest.forgotten &&
				!terminal(latest.status)
			)
				this.save({ ...latest, status: "unknown" });
		}
		return this.read(request.requestId)!;
	}
	event(value: {
		id: string;
		requestId: string;
		generation: number;
		kind: "started" | "waiting" | "completed";
		question?: Omit<ExternalQuestion, "answered">;
		report?: string;
	}) {
		if (!withinJsonLimits(value)) throw new Error("json_resource_limit");
		const event = externalEventSchema.parse(value);
		return this.db
			.transaction(() => {
				const digest = jsonDigest(event);
				const previous = this.db
					.query<{ digest: string }, [string]>(
						"SELECT digest FROM example_external_events WHERE id=?",
					)
					.get(event.id);
				if (previous) {
					if (previous.digest !== digest)
						throw new Error("external_event_identity_conflict");
					return false;
				}
				const record = this.read(event.requestId);
				if (
					!record ||
					record.forgotten ||
					record.request.generation !== event.generation ||
					terminal(record.status) ||
					record.status === "stopping"
				)
					return false;
				this.target(record.request, false);
				if (event.kind === "waiting" && !event.question)
					throw new Error("external_question_required");
				if (event.kind === "waiting") {
					const digest = jsonDigest(event.question);
					const seen = this.db
						.query<{ digest: string }, [string, string]>(
							"SELECT digest FROM example_external_questions WHERE request_id=? AND id=?",
						)
						.get(event.requestId, event.question!.id);
					if (seen) {
						if (seen.digest !== digest)
							throw new Error("external_question_identity_conflict");
						return false;
					}
					this.db
						.query("INSERT INTO example_external_questions VALUES(?,?,?)")
						.run(event.requestId, event.question!.id, digest);
				}
				if (
					event.kind === "started" &&
					!["queued", "delivered", "unknown"].includes(record.status)
				)
					return false;
				this.save({
					...record,
					attempt: (record.attempt ?? 0) + 1,
					status: event.kind,
					...(event.kind === "waiting"
						? {
								question: { ...event.question!, answered: false },
								answer: undefined,
							}
						: {}),
					...(event.report ? { reportedResult: event.report } : {}),
				});
				this.db
					.query("INSERT INTO example_external_events VALUES(?,?)")
					.run(event.id, digest);
				return true;
			})
			.immediate();
	}
	async answer(value: {
		requestId: string;
		questionId: string;
		generation: number;
		text: string;
		sourceRef: string;
	}) {
		if (!withinJsonLimits(value)) throw new Error("json_resource_limit");
		const input = externalAnswerSchema.parse(value);
		const record = this.read(input.requestId);
		if (
			!record ||
			record.request.generation !== input.generation ||
			record.question?.id !== input.questionId
		)
			throw new Error("external_question_changed");
		const target = this.target(record.request);
		if (record.question.kind !== "question")
			return { status: "host_intervention_required" as const };
		if (!this.port.answerQuestion) return { status: "unsupported" as const };
		if (!(
			this.host.source(input.sourceRef)?.active &&
			this.host.source(input.sourceRef)?.kind === "user" &&
			!revokedSources(this.db, this.host.sessionId).has(input.sourceRef)
		))
			throw new Error("external_source_invalid");
		// Preserve existing receipt identity; schema parsing must not reorder the frozen input.
		const digest = jsonDigest(value);
		if (record.answer) {
			if (record.answer.digest !== digest)
				throw new Error("external_answer_identity_conflict");
			return { status: record.answer.status };
		}
		if (record.status !== "waiting" || record.question.answered)
			throw new Error("external_question_changed");
		const attempt = (record.attempt ?? 0) + 1;
		this.save({
			...record,
			attempt,
			answer: { digest, status: "pending", sourceRef: input.sourceRef },
		});
		let status: "sent" | "unknown" = "unknown";
		try {
			status = await this.withPortCall(input.requestId, () =>
				this.port.answerQuestion!(target, input.questionId, input.text),
			);
			this.target(record.request);
		} catch {
			status = "unknown";
		}
		const latest = this.read(input.requestId)!;
		if (
			latest.attempt === attempt &&
			!latest.forgotten &&
			latest.question?.id === input.questionId &&
			latest.status === "waiting"
		) {
			this.save({
				...latest,
				question: { ...latest.question, answered: status === "sent" },
				answer: { digest, status, sourceRef: input.sourceRef },
			});
			return { status };
		}
		return { status: "unknown" as const };
	}
	/** Redacts retained text. `affected` reports each request touched and whether it may still run remotely. */
	forgetSources(sessionId: string, refs: ReadonlySet<string>) {
		if (sessionId !== this.host.sessionId)
			throw new Error("external_session_scope_invalid");
		return this.db
			.transaction(() => {
				revokeSources(this.db, sessionId, refs);
				const affected: Array<{
					id: string;
					previousStatus: ExternalStatus;
					needsStop: boolean;
				}> = [];
				const rows = this.db
					.query<{ body: string }, []>(
						"SELECT body FROM example_external_requests",
					)
					.all();
				for (const row of rows) {
					const record: ExternalRecord = JSON.parse(row.body);
					if (record.request.collaborationSessionId !== sessionId) continue;
					const requestAffected = record.request.sourceRefs.some((ref) =>
						refs.has(ref),
					);
					// Legacy answers lack provenance; their retained text cannot be proven unrelated.
					const answerAffected =
						refs.size > 0 &&
						record.answer &&
						(!record.answer.sourceRef || refs.has(record.answer.sourceRef));
					if (!requestAffected && !answerAffected) continue;
					affected.push({
						id: record.request.requestId,
						previousStatus: record.status,
						needsStop: needsStop(record.status),
					});
					this.save({
						...record,
						forgotten: true,
						attempt: (record.attempt ?? 0) + 1,
						request: { ...record.request, prompt: "", sourceRefs: [] },
						question: undefined,
						reportedResult: undefined,
						answer: undefined,
						independentlyVerified: false,
						status:
							record.status === "queued"
								? "cancelled"
								: terminal(record.status)
									? record.status
									: "unknown",
					});
				}
				return { affected };
			})
			.immediate();
	}
	/**
	 * Explicit recovery, never a resend. The caller supplies the persisted attempt it observed.
	 * The recorded status is not overwritten before inspection; the attempt advances so late callbacks are dropped.
	 * After inspection: `queued` with nothing conclusive becomes `unknown` (delivery outcome unknown);
	 * `delivered`/`started`/`waiting` with nothing conclusive keep their status and report `inspection:"inconclusive"`;
	 * non-terminal observations never move a record backwards (`queued` < `delivered` < `started`; `waiting` is event-driven);
	 * `completed`/`stopped` are always accepted; `stopping`/`unknown` accept any observation. `stopRequested` is kept.
	 */
	async reconcile(
		id: string,
		expectedAttempt: number,
	): Promise<ExternalReconciliation> {
		const record = this.read(id);
		if (!record) throw new Error("external_request_missing");
		if (this.inFlight.has(id)) throw new Error("external_operation_in_flight");
		if ((record.attempt ?? 0) !== expectedAttempt)
			throw new Error("external_attempt_changed");
		if (terminal(record.status) || record.forgotten) return record;
		const target = this.target(record.request, false);
		const attempt = expectedAttempt + 1;
		this.save({
			...record,
			attempt,
			...(record.answer?.status === "pending"
				? { answer: { ...record.answer, status: "unknown" as const } }
				: {}),
		});
		let observed: {
			status: "delivered" | "started" | "completed" | "stopped" | "unknown";
			answer?: "sent" | "unknown";
		} = { status: "unknown" };
		try {
			const inspect = this.port.inspect?.bind(this.port);
			if (inspect)
				observed = await this.withPortCall(id, () => inspect(target, id));
		} catch {
			/* unresolved effects stay as recorded or unknown */
		}
		this.target(record.request, false);
		const latest = this.read(id)!;
		if (
			latest.attempt !== attempt ||
			latest.forgotten ||
			terminal(latest.status)
		)
			return latest;
		const parsed = z
			.strictObject({
				status: z.enum([
					"delivered",
					"started",
					"completed",
					"stopped",
					"unknown",
				]),
				answer: z.enum(["sent", "unknown"]).optional(),
			})
			.safeParse(observed);
		const checked = parsed.success
			? parsed.data
			: { status: "unknown" as const };
		const current = latest.status;
		let status: ExternalStatus;
		let inconclusive = false;
		if (checked.status === "completed" || checked.status === "stopped")
			status = checked.status;
		else if (current === "stopping" || current === "unknown")
			status = checked.status;
		else if (current === "queued")
			status = checked.status; // `unknown` here: the delivery outcome is unknown
		else if (checked.status === "unknown") {
			status = current;
			inconclusive = true;
		} else if (
			current === "waiting" ||
			phase[checked.status] < phase[current as "delivered" | "started"]
		)
			status = current;
		else status = checked.status;
		this.save({
			...latest,
			status,
			...(latest.answer && checked.answer
				? {
						answer: { ...latest.answer, status: checked.answer },
						question: latest.question
							? { ...latest.question, answered: checked.answer === "sent" }
							: undefined,
					}
				: {}),
		});
		const saved = this.read(id)!;
		return {
			...saved,
			...(inconclusive ? { inspection: "inconclusive" as const } : {}),
			...(saved.stopRequested && !terminal(saved.status)
				? { stopPending: true as const }
				: {}),
		};
	}

	async stop(id: string) {
		const record = this.read(id);
		if (!record) throw new Error("external_request_missing");
		if (terminal(record.status)) return record;
		const target = this.target(record.request);
		if (record.status === "stopping") return record;
		const attempt = (record.attempt ?? 0) + 1;
		this.save({
			...record,
			attempt,
			status: "stopping",
			stopRequested: record.stopRequested ?? { attempt },
		});
		let confirmed = false;
		try {
			confirmed =
				(await this.withPortCall(id, () => this.port.stop(target, id))) ===
				"confirmed";
		} catch {
			/* Reconcile unknown termination with the host. */
		}
		const latest = this.read(id)!;
		try {
			this.target(record.request);
		} catch {
			confirmed = false;
		}
		if (
			latest.attempt === attempt &&
			!latest.forgotten &&
			!terminal(latest.status)
		)
			this.save({ ...latest, status: confirmed ? "stopped" : "unknown" });
		return this.read(id)!;
	}
}
