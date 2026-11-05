import { expect, test } from "bun:test";
import { createFixtureModel } from "../adapters/model.ts";
import {
	createClaudeModel,
	type ClaudeModelConfig,
} from "../adapters/claude-model.ts";
import { propose } from "../host.ts";

test("the host parses a scripted proposal without treating it as a committed operation", async () => {
	const result = await propose(
		createFixtureModel([
			{
				action: "invoke",
				tool: "work.edit",
				arguments: { value: 1 },
				text: "変更しました",
			},
		]),
		{
			utterance: "直して",
			course: { course: [], interrupted: null, handedOver: null },
			work: { label: "作品", dirty: false, current: {}, savedRef: null },
			viewing: null,
			time: { now: "2026-11-04T12:00:00+09:00", timeZone: "Asia/Tokyo" },
			callsLeft: 4,
		},
		new AbortController().signal,
	);
	expect(result).toMatchObject({
		ok: true,
		action: { kind: "invoke", tool: "work.edit" },
		costUsd: 0,
	});
});
test("a live adapter requires an explicit model and positive bounded budget before SDK launch", () => {
	expect(() =>
		createClaudeModel({
			model: "",
			cwd: "/tmp",
			maxBudgetUsd: 0,
			maxCalls: 1,
			env: {},
		}),
	).toThrow("test_model_configuration_required");
});
test("a cancelled call never reaches the model adapter", async () => {
	const controller = new AbortController();
	controller.abort();
	await expect(
		createFixtureModel([]).infer({
			messages: [],
			outputSchema: {},
			signal: controller.signal,
		}),
	).rejects.toThrow();
});

test("SDK options isolate inference, measured cost exhausts the budget, and streams close", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	let captured: Parameters<typeof query>[0] | undefined;
	let closed = 0;
	const fake = ((input: Parameters<typeof query>[0]) => {
		captured = input;
		return Object.assign(
			(async function* () {
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					total_cost_usd: 0.2,
					structured_output: { action: "reply", text: "案です" },
				};
			})(),
			{ close: () => closed++ },
		);
	}) as unknown as typeof query;
	const adapter = createClaudeModel(
		{
			model: "runtime-selected",
			cwd: "/tmp",
			maxBudgetUsd: 0.2,
			maxCalls: 2,
			env: {},
		},
		fake,
	);
	const request = {
		messages: [
			{ role: "system" as const, content: "fixed" },
			{ role: "user" as const, content: "request" },
		],
		outputSchema: { type: "object" },
		signal: new AbortController().signal,
	};
	expect(await adapter.infer(request)).toMatchObject({ costUsd: 0.2 });
	expect(captured?.options).toMatchObject({
		tools: [],
		allowedTools: [],
		settingSources: [],
		persistSession: false,
		maxBudgetUsd: 0.2,
		systemPrompt: "fixed",
	});
	expect(captured?.prompt).toBe("request");
	expect(closed).toBe(1);
	await expect(adapter.infer(request)).rejects.toThrow(
		"model_budget_exhausted",
	);
});

test("a failed SDK start leaves unknown cost and cannot be retried automatically", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const fake = (() => {
		throw new Error("transport_failed");
	}) as unknown as typeof query;
	const adapter = createClaudeModel(
		{
			model: "runtime-selected",
			cwd: "/tmp",
			maxBudgetUsd: 1,
			maxCalls: 2,
			env: {},
		},
		fake,
	);
	const request = {
		messages: [{ role: "system" as const, content: "fixed" }],
		outputSchema: {},
		signal: new AbortController().signal,
	};
	await expect(adapter.infer(request)).rejects.toThrow("transport_failed");
	await expect(adapter.infer(request)).rejects.toThrow(
		"model_budget_exhausted",
	);
});

test("omitted environment inherits the launch environment while an explicit map stays isolated", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	for (const env of [undefined, {}]) {
		let captured: Parameters<typeof query>[0] | undefined;
		const fake = ((input: Parameters<typeof query>[0]) => {
			captured = input;
			return Object.assign(
				(async function* () {
					yield {
						type: "result",
						subtype: "success",
						is_error: false,
						total_cost_usd: 0,
						structured_output: { action: "reply", text: "案です" },
					};
				})(),
				{ close() {} },
			);
		}) as unknown as typeof query;
		const adapter = createClaudeModel(
			{
				model: "fixture",
				cwd: "/tmp",
				maxBudgetUsd: 1,
				maxCalls: 1,
				...(env === undefined ? {} : { env }),
			},
			fake,
		);
		await adapter.infer({
			messages: [{ role: "system", content: "fixed" }],
			outputSchema: { type: "object" },
			signal: new AbortController().signal,
		});
		expect(captured !== undefined).toBe(true);
		expect(Object.hasOwn(captured?.options ?? {}, "env")).toBe(
			env !== undefined,
		);
		// Check omission/isolation without printing any inherited credential values.
		expect(captured?.options?.env === undefined).toBe(env === undefined);
		if (env !== undefined)
			expect(Object.keys(captured?.options?.env ?? {}).length).toBe(0);
	}
});

test("SDK cleanup failure still accounts cost and releases the in-flight lock", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	const fake = (() =>
		Object.assign(
			(async function* () {
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					total_cost_usd: 0.2,
					structured_output: { ok: true },
				};
			})(),
			{
				close() {
					throw new Error("close_failed");
				},
			},
		)) as unknown as typeof query;
	const adapter = createClaudeModel(
		{ model: "fixture", cwd: "/tmp", maxBudgetUsd: 0.2, maxCalls: 2, env: {} },
		fake,
	);
	const request = {
		messages: [{ role: "system" as const, content: "fixed" }],
		outputSchema: {},
		signal: new AbortController().signal,
	};
	await expect(adapter.infer(request)).rejects.toThrow("close_failed");
	await expect(adapter.infer(request)).rejects.toThrow(
		"model_budget_exhausted",
	);
});

test("registered native arguments preserve Unicode text without weakening the action contract", async () => {
	const { z } = await import("zod");
	const { ApiBudget } = await import("../adapters/api-budget.ts");
	const { createApiModel } = await import("../adapters/api-model.ts");
	const budget = new ApiBudget(":memory:", 1);
	const args = z.strictObject({
		expectedRevision: z.number().int().nonnegative(),
		content: z.string().max(12000),
	});
	const content = "# 試験\n\n「原文をそのまま。」\n";
	try {
		for (const forbiddenForward of [false, true]) {
			const model = createApiModel({
				provider: "openai",
				model: "gpt-6-luna",
				apiKey: "fixture-key",
				budget,
				maxOutputTokens: 100,
				timeoutMs: 1000,
				fetcher: async (_url, init) => {
					const sent = JSON.parse(String(init.body));
					const schema = sent.text.format.schema.properties.arguments;
					expect(schema.anyOf[0].properties.content.type).toBe("string");
					return Response.json({
						status: "completed",
						usage: { input_tokens: 10, output_tokens: 5 },
						output: [
							{
								content: [
									{
										type: "output_text",
										text: JSON.stringify({
											action: "invoke",
											tool: "doc.write",
											arguments: { expectedRevision: 0, content },
											...(forbiddenForward ? { forward: true } : {}),
										}),
									},
								],
							},
						],
					});
				},
			});
			const result = await propose(
				model,
				{
					utterance: "改訂する",
					course: { course: [], interrupted: null, handedOver: null },
					work: { label: "文書", dirty: false, current: {}, savedRef: null },
					viewing: null,
					time: { now: "2026-11-05T00:00:00+09:00", timeZone: "Asia/Tokyo" },
					callsLeft: 2,
				},
				new AbortController().signal,
				z.toJSONSchema(args),
			);
			expect(result.ok).toBe(!forbiddenForward);
			if (result.ok && result.action.kind === "invoke")
				expect(args.parse(result.action.arguments).content).toBe(content);
		}
	} finally {
		budget.close();
	}
});

test("SDK settings and cost ceilings cannot be changed through the caller's configuration object", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	let captured: Parameters<typeof query>[0] | undefined;
	const fake = ((input: Parameters<typeof query>[0]) => {
		captured = input;
		return Object.assign(
			(async function* () {
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					total_cost_usd: 0.2,
					structured_output: { ok: true },
				};
			})(),
			{ close() {} },
		);
	}) as unknown as typeof query;
	const config: ClaudeModelConfig = {
		model: "fixture",
		cwd: "/tmp",
		maxBudgetUsd: 0.2,
		maxCalls: 2,
		env: { SAFE_ENV: "before" },
	};
	const model = createClaudeModel(config, fake);
	config.model = "changed";
	config.maxBudgetUsd = 99;
	config.env!.SAFE_ENV = "after";
	const request = {
		messages: [{ role: "system" as const, content: "fixed" }],
		outputSchema: {},
		signal: new AbortController().signal,
	};
	await model.infer(request);
	expect(captured?.options?.model).toBe("fixture");
	expect(captured?.options?.env?.SAFE_ENV).toBe("before");
	await expect(model.infer(request)).rejects.toThrow("model_budget_exhausted");
});

test("SDK resource limits reject before launch and account for oversized returned output", async () => {
	const { query } = await import("@anthropic-ai/claude-agent-sdk");
	let launches = 0;
	const fake = (() => {
		launches++;
		return Object.assign(
			(async function* () {
				yield {
					type: "result",
					subtype: "success",
					is_error: false,
					total_cost_usd: 0.2,
					structured_output: { text: "x".repeat(2 * 1024 * 1024) },
				};
			})(),
			{ close() {} },
		);
	}) as unknown as typeof query;
	const model = createClaudeModel(
		{ model: "fixture", cwd: "/tmp", maxBudgetUsd: 0.2, maxCalls: 2, env: {} },
		fake,
	);
	const request = {
		messages: [{ role: "system" as const, content: "fixed" }],
		outputSchema: {},
		signal: new AbortController().signal,
	};
	await expect(
		model.infer({
			...request,
			messages: [{ role: "system", content: "x".repeat(2 * 1024 * 1024) }],
		}),
	).rejects.toThrow("model_input_capacity_exceeded");
	expect(launches).toBe(0);
	await expect(model.infer(request)).rejects.toThrow(
		"model_output_capacity_exceeded",
	);
	expect(launches).toBe(1);
	await expect(model.infer(request)).rejects.toThrow("model_budget_exhausted");
});
