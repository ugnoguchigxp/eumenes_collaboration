import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import {
	ExampleExternalAdapter,
	requestDigest,
	type ExternalPort,
	type ExternalRequest,
	type ExternalStatus,
} from "../adapters/external.ts";

type Observation = Awaited<ReturnType<NonNullable<ExternalPort["inspect"]>>>;
type Inspect = "none" | "throws" | Observation["status"];

const request: ExternalRequest = {
	requestId: "r",
	collaborationSessionId: "s",
	epoch: 2,
	requestRevision: 1,
	projectRef: "p",
	externalSessionRef: "x",
	generation: 1,
	prompt: "synthetic",
	sourceRefs: ["u1"],
	authorityRef: "grant",
};
const { authorityRef, ...frozen } = request;
const grant = {
	ref: authorityRef,
	requestDigest: requestDigest(frozen),
	projectRef: "p",
	externalSessionRef: "x",
	generation: 1,
	requestRevision: 1,
};
const host = {
	sessionId: "s",
	target: () => ({
		projectRef: "p",
		externalSessionRef: "x",
		generation: 1,
		inputOwner: "host" as const,
	}),
	grant: () => grant,
	epoch: () => 2,
	source: () => ({ active: true, kind: "user" as const }),
};

/** A ledger whose single request sits in `status`, inspected by `inspect`. */
async function ledger(inspect: Inspect, status: ExternalStatus) {
	const db = new Database(":memory:");
	const calls = { stop: 0, deliver: 0 };
	const port: ExternalPort = {
		async deliver() {
			calls.deliver++;
			return "delivered";
		},
		async stop() {
			calls.stop++;
			return "unconfirmed";
		},
		answerQuestion: async () => "sent",
	};
	if (inspect === "throws")
		port.inspect = async () => {
			throw new Error("inspect_failed");
		};
	else if (inspect !== "none") port.inspect = async () => ({ status: inspect });
	const adapter = new ExampleExternalAdapter(db, port, host);
	await adapter.submit(request);
	db.query(
		"UPDATE example_external_requests SET body=json_set(body,'$.status',?) WHERE id='r'",
	).run(status);
	return { db, adapter, calls, port };
}
const reconcile = async (inspect: Inspect, status: ExternalStatus) => {
	const f = await ledger(inspect, status);
	try {
		const result = await f.adapter.reconcile(
			"r",
			f.adapter.read("r")!.attempt!,
		);
		return { result, saved: f.adapter.read("r")!, calls: f.calls };
	} finally {
		f.db.close();
	}
};

// Rows of the reconciliation table in spec/improvement-design-2026-11-06.md (B2).
const unresolved: Inspect[] = ["none", "throws", "unknown"];

test("queued (delivery interrupted) with no usable inspection becomes unknown", async () => {
	for (const inspect of unresolved) {
		const { result, saved } = await reconcile(inspect, "queued");
		expect(saved.status).toBe("unknown");
		expect(result.status).toBe("unknown");
	}
});

test("queued takes any conclusive observation", async () => {
	for (const observed of [
		"delivered",
		"started",
		"completed",
		"stopped",
	] as const)
		expect((await reconcile(observed, "queued")).saved.status).toBe(observed);
});

test("delivered, started and waiting keep their state and report an inconclusive inspection", async () => {
	for (const status of ["delivered", "started", "waiting"] as const)
		for (const inspect of unresolved) {
			const { result, saved } = await reconcile(inspect, status);
			expect(saved.status).toBe(status);
			expect(result).toMatchObject({ status, inspection: "inconclusive" });
		}
});

test("non-terminal observations never move delivered, started or waiting backwards", async () => {
	const expected: Array<
		[ExternalStatus, "delivered" | "started", ExternalStatus]
	> = [
		["delivered", "delivered", "delivered"],
		["delivered", "started", "started"],
		["started", "delivered", "started"],
		["started", "started", "started"],
		["waiting", "delivered", "waiting"],
		["waiting", "started", "waiting"],
	];
	for (const [from, observed, next] of expected) {
		const { result, saved } = await reconcile(observed, from);
		expect([from, observed, saved.status]).toEqual([from, observed, next]);
		expect(result.inspection).toBeUndefined();
	}
});

test("any non-terminal state accepts completed or stopped", async () => {
	for (const from of [
		"queued",
		"delivered",
		"started",
		"waiting",
		"stopping",
		"unknown",
	] as const)
		for (const observed of ["completed", "stopped"] as const)
			expect((await reconcile(observed, from)).saved.status).toBe(observed);
});

test("stopping and unknown accept non-terminal observations and keep the stop intent", async () => {
	for (const from of ["stopping", "unknown"] as const)
		for (const observed of ["delivered", "started"] as const) {
			const f = await ledger(observed, from);
			try {
				f.db
					.query(
						"UPDATE example_external_requests SET body=json_set(body,'$.stopRequested',json('{\"attempt\":2}')) WHERE id='r'",
					)
					.run();
				await f.adapter.reconcile("r", f.adapter.read("r")!.attempt!);
				expect(f.adapter.read("r")).toMatchObject({
					status: observed,
					stopRequested: { attempt: 2 },
				});
				expect(f.calls.stop).toBe(0);
			} finally {
				f.db.close();
			}
		}
});

test("stopping and unknown without a usable inspection stay unknown", async () => {
	for (const from of ["stopping", "unknown"] as const)
		for (const inspect of unresolved) {
			const { result, saved } = await reconcile(inspect, from);
			expect(saved.status).toBe("unknown");
			expect(result.inspection).toBeUndefined();
		}
});

test("terminal and forgotten records are returned untouched", async () => {
	for (const status of ["completed", "stopped", "cancelled"] as const) {
		const { saved } = await reconcile("started", status);
		expect(saved.status).toBe(status);
	}
});

test("the status is not overwritten before inspection; the attempt still advances", async () => {
	const f = await ledger("started", "waiting");
	try {
		let during: ReturnType<typeof f.adapter.read>;
		f.port.inspect = async () => {
			during = f.adapter.read("r");
			return { status: "started" };
		};
		const before = f.adapter.read("r")!.attempt!;
		await f.adapter.reconcile("r", before);
		expect(during!).toMatchObject({ status: "waiting", attempt: before + 1 });
	} finally {
		f.db.close();
	}
});

test("a pending answer becomes unknown when reconciliation cannot confirm it", async () => {
	const f = await ledger("none", "waiting");
	try {
		f.db
			.query(
				'UPDATE example_external_requests SET body=json_set(body,\'$.answer\',json(\'{"digest":"d","status":"pending","sourceRef":"u1"}\')) WHERE id=\'r\'',
			)
			.run();
		await f.adapter.reconcile("r", f.adapter.read("r")!.attempt!);
		expect(f.adapter.read("r")).toMatchObject({
			status: "waiting",
			answer: { status: "unknown" },
		});
	} finally {
		f.db.close();
	}
});

test("a waiting request reconciled by a port without inspect can still be answered", async () => {
	const f = await ledger("none", "queued");
	try {
		f.adapter.event({
			id: "started",
			requestId: "r",
			generation: 1,
			kind: "started",
		});
		f.adapter.event({
			id: "wait",
			requestId: "r",
			generation: 1,
			kind: "waiting",
			question: { id: "q", kind: "question", prompt: "どちら" },
		});
		const result = await f.adapter.reconcile(
			"r",
			f.adapter.read("r")!.attempt!,
		);
		expect(result).toMatchObject({
			status: "waiting",
			inspection: "inconclusive",
		});
		expect(
			await f.adapter.answer({
				requestId: "r",
				questionId: "q",
				generation: 1,
				text: "最初の案",
				sourceRef: "u1",
			}),
		).toEqual({ status: "sent" });
	} finally {
		f.db.close();
	}
});

test("an unconfirmed stop records the intent; a later observation keeps it and stop is resent only on an explicit call", async () => {
	const f = await ledger("started", "started");
	try {
		const stopped = await f.adapter.stop("r");
		expect(stopped.status).toBe("unknown");
		expect(stopped.stopRequested).toEqual({ attempt: expect.any(Number) });
		const firstIntent = stopped.stopRequested;
		expect(f.calls.stop).toBe(1);

		const reconciled = await f.adapter.reconcile("r", stopped.attempt!);
		expect(reconciled.status).toBe("started");
		expect(reconciled.stopRequested).toEqual(firstIntent);
		expect(f.calls.stop).toBe(1);

		const retried = await f.adapter.stop("r");
		expect(f.calls.stop).toBe(2);
		expect(retried.stopRequested).toEqual(firstIntent);
		expect(retried.status).toBe("unknown");
	} finally {
		f.db.close();
	}
});

test("a stop in flight is not sent twice and a confirmed stop is terminal", async () => {
	const f = await ledger("none", "started");
	try {
		let finish!: (value: "confirmed") => void;
		f.port.stop = () =>
			new Promise((resolve) => {
				f.calls.stop++;
				finish = resolve;
			});
		const first = f.adapter.stop("r");
		expect(f.adapter.read("r")).toMatchObject({
			status: "stopping",
			stopRequested: { attempt: expect.any(Number) },
		});
		expect((await f.adapter.stop("r")).status).toBe("stopping");
		expect(f.calls.stop).toBe(1);
		finish("confirmed");
		expect(await first).toMatchObject({
			status: "stopped",
			stopRequested: { attempt: expect.any(Number) },
		});
		expect((await f.adapter.stop("r")).status).toBe("stopped");
		expect(f.calls.stop).toBe(1);
	} finally {
		f.db.close();
	}
});

test("reconciling a stop in flight in this process is refused, and a pending stop is reported", async () => {
	const db = new Database(":memory:");
	let release!: (value: "confirmed" | "unconfirmed") => void;
	const port: ExternalPort = {
		async deliver() {
			return "delivered";
		},
		stop: () =>
			new Promise((resolve) => {
				release = resolve;
			}),
		async inspect() {
			return { status: "started" };
		},
	};
	const adapter = new ExampleExternalAdapter(db, port, host);
	try {
		await adapter.submit(request);
		const stopping = adapter.stop("r");
		const attempt = adapter.read("r")!.attempt!;
		await expect(adapter.reconcile("r", attempt)).rejects.toThrow(
			"external_operation_in_flight",
		);
		release("unconfirmed");
		expect((await stopping).status).toBe("unknown");
		// The stop's own result was kept; recovery then reports the stop as still pending.
		const reconciled = await adapter.reconcile(
			"r",
			adapter.read("r")!.attempt!,
		);
		expect(reconciled).toMatchObject({
			status: "started",
			stopRequested: { attempt },
			stopPending: true,
		});
	} finally {
		db.close();
	}
});
