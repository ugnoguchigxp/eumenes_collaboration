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

function fixture(
	options: {
		failDelivery?: boolean;
		failAnswer?: boolean;
		noAnswer?: boolean;
	} = {},
) {
	const db = new Database(":memory:");
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
	return { db, adapter, target, request, deliveries, answers, port, host };
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
			else await f.adapter.reconcile("r", f.adapter.read("r")!.attempt!);
			release("sent");
			expect(await pending).toEqual({ status: "unknown" });
			expect(f.adapter.read("r")?.answer?.status).not.toBe("sent");
		} finally {
			f.db.close();
		}
	}
});
