import { expect, test } from "bun:test";
import { createFixtureModel } from "../adapters/model.ts";
import { createClaudeModel } from "../adapters/claude-model.ts";
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
