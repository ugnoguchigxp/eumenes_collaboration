import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	ExampleExternalAdapter,
	requestDigest,
	type ExternalRequest,
	type ExternalPort,
	type ExternalTarget,
} from "../adapters/external.ts";
import { createEumenesTerminalsPort } from "../adapters/eumenes-terminals.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExampleStateStore } from "../state-store.ts";
import { initial } from "../../test/state.fixture.ts";

function fixture(
	options: {
		failDelivery?: boolean;
		failAnswer?: boolean;
		noAnswer?: boolean;
		path?: string;
	} = {},
) {
	const db = new Database(options.path ?? ":memory:");
	const deliveries: ExternalRequest[] = [];
	const answers: Array<{
		target: ExternalTarget;
		questionId: string;
		text: string;
	}> = [];
	const target: ExternalTarget = {
		projectRef: "p",
		externalSessionRef: "external-s",
		generation: 1,
		inputOwner: "host",
	};
	const request: ExternalRequest = {
		requestId: "r",
		collaborationSessionId: "s",
		epoch: 2,
		requestRevision: 1,
		projectRef: "p",
		externalSessionRef: "external-s",
		generation: 1,
		prompt: "隔離対象の文書を更新し、結果を報告する",
		sourceRefs: ["u1"],
		authorityRef: "grant",
	};
	const { authorityRef, ...frozen } = request;
	const grant = {
		ref: authorityRef,
		requestDigest: requestDigest(frozen),
		projectRef: "p",
		externalSessionRef: "external-s",
		generation: 1,
		requestRevision: 1,
	};
	const port: ExternalPort = {
		async deliver(value) {
			deliveries.push(value);
			if (options.failDelivery) throw new Error("lost_ack");
			return "delivered";
		},
		async stop() {
			return "unconfirmed";
		},
		...(!options.noAnswer
			? {
					async answerQuestion(
						target: ExternalTarget,
						questionId: string,
						text: string,
					) {
						answers.push({ target, questionId, text });
						if (options.failAnswer) throw new Error("lost_ack");
						return "sent" as const;
					},
				}
			: {}),
	};
	const host = {
		sessionId: "s",
		target: () => target,
		grant: (ref: string) => (ref === grant.ref ? grant : undefined),
		epoch: () => 2,
		source: (ref: string) => ({
			active: ref === "u1" || ref === "a1",
			kind: ref === "a1" ? ("assistant" as const) : ("user" as const),
		}),
	};
	const adapter = new ExampleExternalAdapter(db, port, host);
	return {
		db,
		adapter,
		target,
		request,
		deliveries,
		answers,
		port,
		host,
		grant,
	};
}
const question = {
	id: "q",
	kind: "question" as const,
	prompt: "どちらの案にしますか",
};
const answer = {
	requestId: "r",
	questionId: "q",
	generation: 1,
	text: "最初の案",
	sourceRef: "u1",
};

test("requests are delivered once, mutated requests invalidate authority, and reported completion stays unverified", async () => {
	const f = fixture();
	try {
		await expect(
			f.adapter.submit({ ...f.request, prompt: "変更した依頼" }),
		).rejects.toThrow("external_authority_invalid");
		expect((await f.adapter.submit(f.request)).status).toBe("delivered");
		await f.adapter.submit(f.request);
		expect(f.deliveries).toHaveLength(1);
		f.adapter.event({
			id: "done",
			requestId: "r",
			generation: 1,
			kind: "completed",
			report: "完了したとの報告",
		});
		expect(f.adapter.read("r")).toMatchObject({
			status: "completed",
			independentlyVerified: false,
		});
		expect(
			f.adapter.event({
				id: "late",
				requestId: "r",
				generation: 1,
				kind: "started",
			}),
		).toBe(false);
	} finally {
		f.db.close();
	}
});

test("ordinary answers bind to the exact question and duplicate question events never resend", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		const event = {
			id: "event",
			requestId: "r",
			generation: 1,
			kind: "waiting" as const,
			question,
		};
		expect(f.adapter.event(event)).toBe(true);
		await expect(
			f.adapter.answer({ ...answer, sourceRef: "a1" }),
		).rejects.toThrow("external_source_invalid");
		expect(await f.adapter.answer(answer)).toEqual({ status: "sent" });
		expect(f.adapter.event(event)).toBe(false);
		expect(f.adapter.event({ ...event, id: "another-copy" })).toBe(false);
		await f.adapter.answer(answer);
		expect(f.answers).toHaveLength(1);
		expect(f.answers[0]).toMatchObject({
			target: { externalSessionRef: "external-s", generation: 1 },
			questionId: "q",
		});
		await expect(
			f.adapter.answer({ ...answer, questionId: "other" }),
		).rejects.toThrow("external_question_changed");
	} finally {
		f.db.close();
	}
});

test("permission and authentication questions require host intervention and never become ordinary answers", async () => {
	for (const kind of ["permission", "authentication"] as const) {
		const f = fixture();
		try {
			await f.adapter.submit(f.request);
			f.adapter.event({
				id: "q",
				requestId: "r",
				generation: 1,
				kind: "waiting",
				question: { ...question, kind },
			});
			expect(await f.adapter.answer(answer)).toEqual({
				status: "host_intervention_required",
			});
			expect(f.answers).toHaveLength(0);
		} finally {
			f.db.close();
		}
	}
});

test("manual input ownership and changed generation prevent automated input", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		f.adapter.event({
			id: "q",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		f.target.inputOwner = "user";
		await expect(f.adapter.answer(answer)).rejects.toThrow(
			"external_target_changed",
		);
		f.target.inputOwner = "host";
		f.target.generation = 2;
		await expect(f.adapter.answer(answer)).rejects.toThrow(
			"external_target_changed",
		);
		expect(f.answers).toHaveLength(0);
	} finally {
		f.db.close();
	}
});

test("delivery and answer uncertainty survive adapter reconstruction without automatic resend", async () => {
	const f = fixture({ failDelivery: true, failAnswer: true });
	try {
		expect((await f.adapter.submit(f.request)).status).toBe("unknown");
		const reopened = new ExampleExternalAdapter(f.db, f.port, f.host);
		await reopened.submit(f.request);
		expect(f.deliveries).toHaveLength(1);
		reopened.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		expect(await reopened.answer(answer)).toEqual({ status: "unknown" });
		await new ExampleExternalAdapter(f.db, f.port, f.host).answer(answer);
		expect(f.answers).toHaveLength(1);
		expect((await reopened.stop("r")).status).toBe("unknown");
	} finally {
		f.db.close();
	}
});

test("forgotten source text is removed from pending requests and cannot return through replay or a late event", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		f.adapter.forgetSources("s", new Set(["u1"]));
		expect(f.adapter.read("r")).toMatchObject({
			forgotten: true,
			request: { prompt: "", sourceRefs: [] },
			status: "unknown",
		});
		await f.adapter.submit(f.request);
		expect(f.deliveries).toHaveLength(1);
		expect(
			f.adapter.event({
				id: "late",
				requestId: "r",
				generation: 1,
				kind: "completed",
				report: f.request.prompt,
			}),
		).toBe(false);
		expect(JSON.stringify(f.adapter.read("r"))).not.toContain(f.request.prompt);
	} finally {
		f.db.close();
	}
});

test("the current Eumenes terminals bridge advertises no structured answer support", async () => {
	const f = fixture();
	try {
		const port = createEumenesTerminalsPort({
			async enqueue() {},
			async stop() {
				return "unconfirmed";
			},
		});
		expect(port.answerQuestion).toBeUndefined();
		const adapter = new ExampleExternalAdapter(f.db, port, f.host);
		await adapter.submit(f.request);
		adapter.event({
			id: "q",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		expect(await adapter.answer(answer)).toEqual({ status: "unsupported" });
	} finally {
		f.db.close();
	}
});

test("forgetting is scoped to its collaboration session even if local source refs coincide", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		expect(() =>
			f.adapter.forgetSources("another-session", new Set(["u1"])),
		).toThrow("external_session_scope_invalid");
		expect(f.adapter.read("r")).toMatchObject({
			status: "delivered",
			request: { prompt: f.request.prompt },
		});
	} finally {
		f.db.close();
	}
});

test("manual input ownership blocks automated writes but does not discard progress observations", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		f.target.inputOwner = "user";
		expect(
			f.adapter.event({
				id: "reported",
				requestId: "r",
				generation: 1,
				kind: "completed",
				report: "外部agentの報告",
			}),
		).toBe(true);
		expect(f.adapter.read("r")).toMatchObject({
			status: "completed",
			independentlyVerified: false,
		});
	} finally {
		f.db.close();
	}
});

test("an adapter cannot read, answer, or stop another collaboration session's request", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		const other = new ExampleExternalAdapter(f.db, f.port, {
			...f.host,
			sessionId: "other",
		});
		expect(other.read("r")).toBeNull();
		await expect(other.stop("r")).rejects.toThrow("external_request_missing");
		await expect(other.answer(answer)).rejects.toThrow(
			"external_question_changed",
		);
		expect(f.deliveries).toHaveLength(1);
	} finally {
		f.db.close();
	}
});

test("reconciliation fences interrupted delivery without resending or accepting stale callbacks", async () => {
	const f = fixture();
	let release!: (value: "delivered") => void;
	f.port.deliver = () => new Promise((resolve) => (release = resolve));
	try {
		const pending = f.adapter.submit(f.request);
		const restarted = new ExampleExternalAdapter(f.db, f.port, f.host);
		const before = restarted.read("r")!;
		expect((await restarted.reconcile("r", before.attempt ?? 0)).status).toBe(
			"unknown",
		);
		release("delivered");
		await pending;
		expect(restarted.read("r")?.status).toBe("unknown");
		await expect(restarted.reconcile("r", before.attempt ?? 0)).rejects.toThrow(
			"external_attempt_changed",
		);
		f.port.inspect = async () => ({ status: "stopped" });
		const current = restarted.read("r")!;
		expect((await restarted.reconcile("r", current.attempt ?? 0)).status).toBe(
			"stopped",
		);
		expect(restarted.read("r")?.independentlyVerified).toBe(false);
	} finally {
		f.db.close();
	}
});

test("a reconciled or forgotten answer cannot return a stale success to its caller", async () => {
	for (const mode of ["reconcile", "forget"]) {
		const f = fixture();
		let release!: (status: "sent") => void;
		f.port.answerQuestion = () =>
			new Promise((resolve) => {
				release = resolve;
			});
		try {
			await f.adapter.submit(f.request);
			f.adapter.event({
				id: "question",
				requestId: "r",
				generation: 1,
				kind: "waiting",
				question,
			});
			const pending = f.adapter.answer(answer);
			if (mode === "forget") f.adapter.forgetSources("s", new Set(["u1"]));
			else {
				// The live process refuses to reconcile its own call in flight.
				await expect(
					f.adapter.reconcile("r", f.adapter.read("r")!.attempt!),
				).rejects.toThrow("external_operation_in_flight");
				// Recovery from another process (or after a restart) fences the late answer instead.
				const recovery = new ExampleExternalAdapter(f.db, f.port, f.host);
				await recovery.reconcile("r", recovery.read("r")!.attempt!);
			}
			release("sent");
			expect(await pending).toEqual({ status: "unknown" });
			expect(f.adapter.read("r")?.answer?.status).not.toBe("sent");
		} finally {
			f.db.close();
		}
	}
});

test("a live question arriving during inspection cannot be overwritten by the older inspection", async () => {
	const f = fixture();
	let release!: (value: { status: "started" }) => void;
	f.port.inspect = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	try {
		await f.adapter.submit(f.request);
		const pending = f.adapter.reconcile("r", f.adapter.read("r")!.attempt!);
		f.adapter.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		release({ status: "started" });
		expect((await pending).status).toBe("waiting");
		expect(await f.adapter.answer(answer)).toEqual({ status: "sent" });
	} finally {
		f.db.close();
	}
});

test("revoked sources block first-time delivery and answers even when the host snapshot still says active", async () => {
	const f = fixture();
	try {
		f.adapter.forgetSources("s", new Set(["u1"]));
		const reopened = new ExampleExternalAdapter(f.db, f.port, f.host);
		await expect(reopened.submit(f.request)).rejects.toThrow(
			"external_source_invalid",
		);
		expect(f.deliveries).toEqual([]);
		f.request.sourceRefs = ["a1"];
		const { authorityRef: _authorityRef, ...frozen } = f.request;
		f.grant.requestDigest = requestDigest(frozen);
		await reopened.submit(f.request);
		reopened.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		await expect(reopened.answer(answer)).rejects.toThrow(
			"external_source_invalid",
		);
		expect(f.answers).toEqual([]);
	} finally {
		f.db.close();
	}
});

test("revocation before state initialization survives adapter-to-store handover", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-revocation-"));
	const path = join(dir, "state.sqlite");
	const f = fixture({ path });
	f.adapter.forgetSources("s", new Set(["u1"]));
	f.db.close();
	const store = new ExampleStateStore(path);
	try {
		expect(() => store.initialize(initial(), 2)).toThrow("source_invalid");
		expect(store.read("s")).toBeNull();
	} finally {
		store.close();
		await rm(dir, { recursive: true, force: true });
	}
});

test("oversized external provenance is rejected before querying the host registry", async () => {
	const f = fixture();
	let sources = 0;
	f.host.source = () => {
		sources++;
		return { active: true, kind: "user" as const };
	};
	try {
		await expect(
			f.adapter.submit({ ...f.request, sourceRefs: Array(100001).fill("u1") }),
		).rejects.toThrow("json_resource_limit");
		expect(sources).toBe(0);
		expect(f.deliveries).toEqual([]);
	} finally {
		f.db.close();
	}
});

test("an in-flight stop keeps its original target generation when the host registry changes", async () => {
	const f = fixture();
	let release!: (value: "confirmed") => void;
	let sent: ExternalTarget | undefined;
	f.port.stop = (target) => {
		sent = target;
		return new Promise((resolve) => {
			release = resolve;
		});
	};
	try {
		await f.adapter.submit(f.request);
		const pending = f.adapter.stop("r");
		f.target.generation = 2;
		expect(sent?.generation).toBe(1);
		release("confirmed");
		expect((await pending).status).toBe("unknown");
	} finally {
		f.db.close();
	}
});

test("forgetting an answer's source fences its late result even if the original request used another source", async () => {
	const f = fixture();
	f.request.sourceRefs = ["a1"];
	const { authorityRef: _authorityRef, ...frozen } = f.request;
	f.grant.requestDigest = requestDigest(frozen);
	let release!: (value: "sent") => void;
	f.port.answerQuestion = () =>
		new Promise((resolve) => {
			release = resolve;
		});
	try {
		await f.adapter.submit(f.request);
		f.adapter.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		const pending = f.adapter.answer(answer);
		f.adapter.forgetSources("s", new Set(["u1"]));
		release("sent");
		expect(await pending).toEqual({ status: "unknown" });
		expect(f.adapter.read("r")).toMatchObject({
			forgotten: true,
			request: { prompt: "", sourceRefs: [] },
		});
	} finally {
		f.db.close();
	}
});

test("revocation is scoped to its collaboration session and does not block another session's same local ref", async () => {
	const f = fixture();
	try {
		f.adapter.forgetSources("s", new Set(["u1"]));
		f.host.sessionId = "other";
		f.request.collaborationSessionId = "other";
		f.request.requestId = "other-r";
		const { authorityRef: _authorityRef, ...frozen } = f.request;
		f.grant.requestDigest = requestDigest(frozen);
		const other = new ExampleExternalAdapter(f.db, f.port, f.host);
		expect((await other.submit(f.request)).status).toBe("delivered");
		expect(f.deliveries.length).toBe(1);
	} finally {
		f.db.close();
	}
});

test("legacy answers with unknown provenance are redacted on nonempty session forgetting", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		f.adapter.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		await f.adapter.answer(answer);
		const legacy = f.adapter.read("r")!;
		delete legacy.answer!.sourceRef;
		f.db
			.query("UPDATE example_external_requests SET body=? WHERE id='r'")
			.run(JSON.stringify(legacy));
		f.adapter.forgetSources("s", new Set());
		expect(f.adapter.read("r")?.forgotten).not.toBe(true);
		f.adapter.forgetSources("s", new Set(["unknown-old-source"]));
		expect(f.adapter.read("r")).toMatchObject({
			forgotten: true,
			request: { prompt: "", sourceRefs: [] },
		});
	} finally {
		f.db.close();
	}
});

test("legacy answer receipt identity keeps the original frozen JSON key order", async () => {
	const f = fixture();
	try {
		await f.adapter.submit(f.request);
		f.adapter.event({
			id: "question",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question,
		});
		const input = {
			text: answer.text,
			sourceRef: answer.sourceRef,
			generation: 1,
			requestId: "r",
			questionId: "q",
		};
		const legacy = f.adapter.read("r")!;
		legacy.answer = {
			digest: new Bun.CryptoHasher("sha256")
				.update(JSON.stringify(input))
				.digest("hex"),
			status: "sent",
		};
		legacy.question!.answered = true;
		f.db
			.query("UPDATE example_external_requests SET body=? WHERE id='r'")
			.run(JSON.stringify(legacy));
		expect(await f.adapter.answer(input)).toEqual({ status: "sent" });
		expect(f.answers).toEqual([]);
	} finally {
		f.db.close();
	}
});
