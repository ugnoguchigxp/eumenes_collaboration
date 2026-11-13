import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import development from "../eval/proactive/development.json";
import holdout from "../eval/proactive/holdout.json";
import { checkInventory, summarizeRuns } from "../eval/proactive/index.ts";
import {
	captureCase,
	splitSupplement,
	supplementRequest,
} from "../eval/proactive/supplement-trial.mjs";

const checked = checkInventory(development, holdout);
const task = checked.holdout[0]!;
const run = {
	taskId: task.id,
	mode: "A",
	repetition: 1,
	status: "completed",
	conditionsMet: true,
	followUps: 0,
	rework: 0,
	unnecessaryProposals: 0,
	boundaryViolations: 0,
	foregroundMs: [200, 400],
};

test("proactive inventory separates development and holdout and forbids duplicate cases", () => {
	expect(checked.development).toHaveLength(6);
	expect(checked.holdout).toHaveLength(24);
	expect(() =>
		checkInventory(development, [
			{ ...holdout[0], id: development[0]!.id },
			...holdout.slice(1),
		]),
	).toThrow("proactive_duplicate_task_id");
});

test("failed runs remain in the denominator even when some conditions were met", () => {
	const summary = summarizeRuns(
		[run, { ...run, repetition: 2, status: "failed", foregroundMs: [] }],
		[task],
		["A"],
	);
	expect(summary[0]).toMatchObject({
		mode: "A",
		runs: 2,
		conditionsMet: 1,
		unassistedCompletion: 1,
		foregroundP95Ms: 400,
	});
});

test("a follow-up or boundary violation prevents unassisted completion", () => {
	const summary = summarizeRuns(
		[
			{ ...run, followUps: 1 },
			{ ...run, repetition: 2, boundaryViolations: 1 },
		],
		[task],
		["A"],
	);
	expect(summary[0]).toMatchObject({
		conditionsMet: 2,
		unassistedCompletion: 0,
		followUps: 1,
		boundaryViolations: 1,
	});
});

test("the same case and repetition are required in every compared mode", () => {
	const repeat = { ...run, repetition: 2 };
	const other = { ...run, mode: "B" };
	expect(() =>
		summarizeRuns([run, repeat, other, other], [task], ["A", "B"]),
	).toThrow("proactive_incomplete_or_unpaired_runs");
	expect(() => summarizeRuns([run, repeat, other], [task], ["A", "B"])).toThrow(
		"proactive_incomplete_or_unpaired_runs",
	);
	expect(
		summarizeRuns(
			[run, repeat, other, { ...other, repetition: 2 }],
			[task],
			["A", "B"],
		),
	).toHaveLength(2);
});

test("A+ extends the existing response schema while retaining its state and user message", () => {
	const messages = [
		{ role: "system", content: "通常の担当指示" },
		{ role: "user", content: "利用者の原文" },
	];
	const schema = {
		type: "object",
		properties: { action: { type: "string" }, stateUpdate: { type: "object" } },
		required: ["action", "stateUpdate"],
	};
	const extended = supplementRequest(messages, schema);
	expect(extended.messages[0]?.content).toStartWith(messages[0]!.content);
	expect(extended.messages[1]).toBe(messages[1]!);
	expect(extended.outputSchema.required).toEqual([
		"action",
		"stateUpdate",
		"supplement",
	]);
	expect(extended.outputSchema.properties.stateUpdate).toBe(
		schema.properties.stateUpdate,
	);
	expect(schema.required).toEqual(["action", "stateUpdate"]);
});

test("A+ separates supplements from accepted reply shapes and withholds invalid supplements", () => {
	const action = {
		action: "invoke",
		tool: "doc.edit",
		arguments: {},
		text: "編集しました。",
		stateUpdate: { upserts: [], removals: [] },
	};
	expect(splitSupplement({ ...action, supplement: "次の判断材料" })).toEqual({
		action,
		valid: true,
		supplement: "次の判断材料",
	});
	expect(
		splitSupplement({ ...action, text: null, supplement: "次の判断材料" }),
	).toMatchObject({
		valid: false,
		supplement: null,
	});
	expect(
		splitSupplement({ action: "reply", text: "待ちます。", supplement: null }),
	).toMatchObject({
		valid: true,
		supplement: null,
	});
	expect(
		splitSupplement({
			action: "reply",
			text: "完了",
			supplement: "あ".repeat(301),
		}),
	).toMatchObject({
		valid: false,
		supplement: null,
	});
});

const host = process.env.PROACTIVE_EUMENES_SOURCE;
test.skipIf(!host)(
	"A+ uses the fixed host's rendered schema and attaches the supplement after the reply",
	async () => {
		const { harness } = await import(
			pathToFileURL(
				resolve(host!, "api/application/toolchain/toolchain.fixture.ts"),
			).href
		);
		const lanes: string[] = [];
		const result = await captureCase(
			checked.development[0]!,
			harness,
			async (
				lane: string,
				request: { messages: { content: string }[]; outputSchema?: unknown },
			) => {
				lanes.push(lane);
				const base = request.messages
					.flatMap(({ content }) => content.split("\n"))
					.find((line) => line.startsWith("STATE_UPDATE_BASE="));
				expect(base).toBeDefined();
				const stateUpdate = JSON.parse(
					base!.slice("STATE_UPDATE_BASE=".length),
				);
				if (lane === "opening")
					return {
						output: {
							action: "invoke",
							tool: "doc.write",
							arguments: {
								baseRevision: 0,
								title: "献立",
								content: {
									view: "layout",
									direction: "stack",
									children: [
										{ view: "text-block", title: "献立", body: "定食" },
									],
								},
							},
							text: "献立を作りました。",
							stateUpdate,
						},
					};
				const system = request.messages[0]!.content;
				const schema = JSON.parse(
					system.slice(
						system.lastIndexOf("\nOUTPUT_SCHEMA=") + "\nOUTPUT_SCHEMA=".length,
					),
				);
				expect(schema.properties.stateUpdate).toBeDefined();
				expect(schema.required).toContain("supplement");
				expect(request.outputSchema).toBeUndefined();
				return {
					output: {
						action: "reply",
						text: "次の確認に進めます。",
						supplement: "選んだ献立名を引き継げます。",
						stateUpdate,
					},
				};
			},
		);
		expect(lanes).toEqual(["opening", "A+-update"]);
		expect(result).toMatchObject({
			status: "ok",
			turns: [
				{ status: "completed" },
				{ status: "completed", answer: "次の確認に進めます。" },
			],
			supplementMessage: {
				role: "assistant",
				text: "選んだ献立名を引き継げます。",
			},
		});
	},
	15_000,
);
