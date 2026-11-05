import { test, expect } from "bun:test";
import { ApiBudget } from "../adapters/api-budget.ts";
import { createApiModel, apiSchema } from "../adapters/api-model.ts";
import { z } from "zod";
import { stateProposalSchema } from "../../src/index.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
test("shared budget reserves atomically, retains unknown spend and refuses a changed or invalid settlement", () => {
	const b = new ApiBudget(":memory:", 1);
	try {
		const id = b.reserve("openai", 0.7);
		expect(() => b.reserve("anthropic", 0.4)).toThrow("api_budget_exhausted");
		expect(() => b.settle(id, 0.8, {})).toThrow();
		expect(b.used()).toBe(0.7);
		b.settle(id, 0.1, {});
		expect(b.used()).toBe(0.1);
		expect(() => b.settle(id, 0, {})).toThrow();
		expect(() => b.reserve("openai", NaN)).toThrow();
	} finally {
		b.close();
	}
});

test("budget identity and uncertain spend persist across connections and process-style reopen", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-api-budget-"));
	const path = join(dir, "budget.sqlite");
	const left = new ApiBudget(path, 1),
		right = new ApiBudget(path, 1);
	try {
		left.reserve("anthropic", 0.7);
		expect(() => right.reserve("openai", 0.4)).toThrow("api_budget_exhausted");
		expect(() => new ApiBudget(path, 2)).toThrow(
			"api_budget_identity_conflict",
		);
	} finally {
		left.close();
		right.close();
	}
	const reopened = new ApiBudget(path, 1);
	try {
		expect(reopened.used()).toBe(0.7);
		expect(() => reopened.reserve("openai", 0.4)).toThrow(
			"api_budget_exhausted",
		);
	} finally {
		reopened.close();
		await rm(dir, { recursive: true, force: true });
	}
});
test("provider JSON representation round-trips opaque JSON without changing host constraints", () => {
	const wire = apiSchema(z.toJSONSchema(stateProposalSchema));
	const data = {
		coreContractVersion: 1,
		sessionId: "s",
		epoch: 1,
		expectedRevision: 0,
		sourceRevision: 1,
		work: { ref: "w", revision: 0, digest: "d" },
		upserts: [
			{
				id: "f",
				kind: "condition",
				status: "confirmed",
				value: { json: '{"nested":[1,null,"x"]}' },
				sourceRefs: ["u"],
				supersedes: [],
			},
		],
		removals: [],
	};
	expect(
		stateProposalSchema.parse(wire.decode(data)).upserts[0]?.value,
	).toEqual({ nested: [1, null, "x"] });
});
test("API failures never retry or release uncertain reservations; successful responses expose bounded metadata only", async () => {
	const b = new ApiBudget(":memory:", 1);
	let calls = 0;
	try {
		const model = createApiModel({
			provider: "openai",
			model: "gpt-6-luna",
			apiKey: "fixture-only",
			budget: b,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			fetcher: async () => {
				calls++;
				return Response.json({ error: "no" }, { status: 429 });
			},
		});
		const request = {
			messages: [
				{ role: "system" as const, content: "fixed" },
				{ role: "user" as const, content: "hello" },
			],
			outputSchema: {
				type: "object",
				properties: { ok: { type: "boolean" } },
				required: ["ok"],
				additionalProperties: false,
			},
			signal: new AbortController().signal,
		};
		await expect(model.infer(request)).rejects.toThrow("api_http_429");
		expect(calls).toBe(1);
		expect(b.used() > 0).toBe(true);
		const ok = createApiModel({
			provider: "openai",
			model: "gpt-6-luna",
			apiKey: "fixture-only",
			budget: b,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			fetcher: async () =>
				Response.json({
					status: "completed",
					model: "gpt-6-luna",
					usage: { input_tokens: 10, output_tokens: 5 },
					output: [{ content: [{ type: "output_text", text: '{"ok":true}' }] }],
				}),
		});
		expect((await ok.infer(request)).output).toEqual({ ok: true });
		const controller = new AbortController();
		controller.abort();
		await expect(
			ok.infer({ ...request, signal: controller.signal }),
		).rejects.toThrow();
	} finally {
		b.close();
	}
});

test("unsupported provider bounds remain enforced by the original host schema, including nullable branches", () => {
	const schema = z.strictObject({
		nested: z
			.strictObject({
				n: z.number().int().nonnegative(),
				text: z.string().min(1),
			})
			.nullable(),
	});
	const wire = apiSchema(z.toJSONSchema(schema));
	expect(JSON.stringify(wire.schema).includes('"minimum":')).toBe(false);
	expect(JSON.stringify(wire.schema).includes('"minLength":')).toBe(false);
	expect(
		schema.safeParse(wire.decode({ nested: { n: -1, text: "" } })).success,
	).toBe(false);
});

test("wire primitives never require a second JSON parse and tagged aggregates remain lossless", () => {
	const wire = apiSchema({ $ref: "#/$defs/json" });
	for (const value of ["日本語", "123", "null", true, 42, null])
		expect(wire.decode(value)).toEqual(value);
	for (const value of [{ a: [1, null, "x"] }, [1, "x"], { json: "literal" }])
		expect(wire.decode({ json: JSON.stringify(value) })).toEqual(value);
	expect(() => wire.decode({ json: "not JSON" })).toThrow(
		"api_json_value_invalid",
	);
});

test("both APIs keep incomplete, refused, malformed and disconnected responses visible without retries", async () => {
	for (const provider of ["anthropic", "openai"] as const) {
		for (const failure of [
			"incomplete",
			"refused",
			"missing-usage",
			"invalid-json",
			"disconnected",
			"server-error",
			"oversized",
		]) {
			const budget = new ApiBudget(":memory:", 1);
			let calls = 0;
			const usage = { input_tokens: 10, output_tokens: 5 };
			try {
				const model = createApiModel({
					provider,
					model: provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna",
					apiKey: "fixture-key",
					budget,
					maxOutputTokens: 100,
					timeoutMs: 1000,
					fetcher: async () => {
						calls++;
						if (failure === "disconnected") throw new Error("connection_reset");
						if (failure === "server-error")
							return new Response("", { status: 503 });
						if (failure === "invalid-json") return new Response("{");
						if (failure === "oversized")
							return new Response(
								new ReadableStream({
									start(controller) {
										controller.enqueue(new Uint8Array(2 * 1024 * 1024 + 1));
									},
								}),
							);
						return Response.json(
							provider === "anthropic"
								? {
										stop_reason:
											failure === "incomplete" ? "max_tokens" : "end_turn",
										...(failure !== "missing-usage" ? { usage } : {}),
										content: [],
									}
								: {
										status:
											failure === "incomplete" ? "incomplete" : "completed",
										...(failure !== "missing-usage" ? { usage } : {}),
										output: [{ content: [{ type: "refusal", refusal: "no" }] }],
									},
						);
					},
				});
				await expect(
					model.infer({
						messages: [
							{ role: "system", content: "fixed" },
							{ role: "user", content: "fixture" },
						],
						outputSchema: {
							type: "object",
							properties: {},
							required: [],
							additionalProperties: false,
						},
						signal: new AbortController().signal,
					}),
				).rejects.toThrow();
				expect(calls).toBe(1);
				expect(budget.used() > 0).toBe(true);
				const row = budget.db
					.query<{ status: string }, []>("SELECT status FROM api_calls")
					.get();
				expect(row?.status).toBe(
					["incomplete", "refused"].includes(failure) ? "estimated" : "pending",
				);
			} finally {
				budget.close();
			}
		}
	}
});

test("cancellation reaches the HTTP request and preserves the uncertain reservation", async () => {
	const budget = new ApiBudget(":memory:", 1);
	const controller = new AbortController();
	let launched!: () => void;
	const started = new Promise<void>((resolve) => {
		launched = resolve;
	});
	try {
		const model = createApiModel({
			provider: "openai",
			model: "gpt-6-luna",
			apiKey: "fixture-key",
			budget,
			maxOutputTokens: 100,
			timeoutMs: 1000,
			fetcher: (_url, init) =>
				new Promise((_resolve, reject) => {
					init.signal!.addEventListener(
						"abort",
						() => reject(new Error("cancelled")),
						{ once: true },
					);
					launched();
				}),
		});
		const call = model.infer({
			messages: [{ role: "system", content: "fixed" }],
			outputSchema: {},
			signal: controller.signal,
		});
		await started;
		controller.abort();
		await expect(call).rejects.toThrow("cancelled");
		expect(budget.used() > 0).toBe(true);
	} finally {
		budget.close();
	}
});
