import { Database } from "bun:sqlite";
import { z } from "zod";

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
	answer?: { digest: string; status: "pending" | "sent" | "unknown" };
	/** Persisted fencing token; old async replies may not overwrite reconciliation. */
	attempt?: number;
};
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
export const requestDigest = (request: Omit<ExternalRequest, "authorityRef">) =>
	new Bun.CryptoHasher("sha256")
		.update(
			JSON.stringify(
				externalRequestSchema.omit({ authorityRef: true }).parse(request),
			),
		)
		.digest("hex");
const jsonDigest = (value: unknown) =>
	new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const terminal = (status: ExternalStatus) =>
	["completed", "stopped", "cancelled"].includes(status);

/** Example lifecycle ledger. Targets, grants, epochs and sources are supplied by the host. */
export class ExampleExternalAdapter {
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
		return target;
	}
	async submit(value: unknown) {
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
		if (!request.sourceRefs.every((ref) => this.host.source(ref)?.active))
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
			const status = await this.port.deliver(request);
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
	async answer(input: {
		requestId: string;
		questionId: string;
		generation: number;
		text: string;
		sourceRef: string;
	}) {
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
			this.host.source(input.sourceRef)?.kind === "user"
		))
			throw new Error("external_source_invalid");
		const digest = jsonDigest(input);
		if (record.answer) {
			if (record.answer.digest !== digest)
				throw new Error("external_answer_identity_conflict");
			return { status: record.answer.status };
		}
		if (record.status !== "waiting" || record.question.answered)
			throw new Error("external_question_changed");
		const attempt = (record.attempt ?? 0) + 1;
		this.save({ ...record, attempt, answer: { digest, status: "pending" } });
		let status: "sent" | "unknown" = "unknown";
		try {
			status = await this.port.answerQuestion(
				target,
				input.questionId,
				input.text,
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
		)
			this.save({
				...latest,
				question: { ...latest.question, answered: status === "sent" },
				answer: { digest, status },
			});
		return { status };
	}
	forgetSources(sessionId: string, refs: ReadonlySet<string>) {
		if (sessionId !== this.host.sessionId)
			throw new Error("external_session_scope_invalid");
		this.db
			.transaction(() => {
				const rows = this.db
					.query<{ body: string }, []>(
						"SELECT body FROM example_external_requests",
					)
					.all();
				for (const row of rows) {
					const record: ExternalRecord = JSON.parse(row.body);
					if (record.request.collaborationSessionId !== sessionId) continue;
					if (!record.request.sourceRefs.some((ref) => refs.has(ref))) continue;
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
			})
			.immediate();
	}
	/** Explicit recovery, never a resend. The caller supplies the persisted attempt it observed. */
	async reconcile(id: string, expectedAttempt: number) {
		const record = this.read(id);
		if (!record) throw new Error("external_request_missing");
		if ((record.attempt ?? 0) !== expectedAttempt)
			throw new Error("external_attempt_changed");
		if (terminal(record.status) || record.forgotten) return record;
		const target = this.target(record.request, false);
		const attempt = expectedAttempt + 1;
		this.save({
			...record,
			attempt,
			status: "unknown",
			...(record.answer?.status === "pending"
				? { answer: { ...record.answer, status: "unknown" as const } }
				: {}),
		});
		let observed: {
			status: "delivered" | "started" | "completed" | "stopped" | "unknown";
			answer?: "sent" | "unknown";
		} = { status: "unknown" };
		try {
			if (this.port.inspect) observed = await this.port.inspect(target, id);
		} catch {
			/* unresolved effects stay unknown */
		}
		this.target(record.request, false);
		const latest = this.read(id)!;
		if (
			latest.attempt !== attempt ||
			latest.forgotten ||
			terminal(latest.status)
		)
			return latest;
		const checked = z
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
			.parse(observed);
		this.save({
			...latest,
			status: checked.status,
			...(latest.answer && checked.answer
				? {
						answer: { ...latest.answer, status: checked.answer },
						question: latest.question
							? { ...latest.question, answered: checked.answer === "sent" }
							: undefined,
					}
				: {}),
		});
		return this.read(id)!;
	}

	async stop(id: string) {
		const record = this.read(id);
		if (!record) throw new Error("external_request_missing");
		if (terminal(record.status)) return record;
		const target = this.target(record.request);
		if (record.status === "stopping") return record;
		const attempt = (record.attempt ?? 0) + 1;
		this.save({ ...record, attempt, status: "stopping" });
		let confirmed = false;
		try {
			confirmed = (await this.port.stop(target, id)) === "confirmed";
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
