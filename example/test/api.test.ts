import { test, expect } from "bun:test";
import { ApiBudget } from "../adapters/api-budget.ts";
import { createApiModel, apiSchema } from "../adapters/api-model.ts";
import { z } from "zod";
import { stateProposalSchema } from "../../src/index.ts";
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
