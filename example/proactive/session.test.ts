import { expect, test } from "bun:test";
import { startTrial, type TrialServices } from "./session.ts";
import { input } from "./scenario.ts";

test("a reply can be published first; a blocked review does not stop skill execution", async () => {
	const reviewing = Promise.withResolvers<void>();
	const artifact = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const signal = AbortSignal.timeout(3000);
	const calls: string[] = [];
	const services: TrialServices = {
		async review(current, selection) {
			expect(current.work.version).toBe("1");
			expect(selection.conditionIds).toEqual(["heading"]);
			calls.push("review");
			reviewing.resolve();
			await release.promise;
			return { status: "completed" };
		},
		async skill(current) {
			calls.push("skill");
			expect(current.work.version).toBe("1");
			return {
				skill: {
					name: "sheet",
					content: "運用照合キー RZ-47",
					files: [],
					bundleDigest: "fixture",
				},
				dependencies: [],
				sourceCalls: [],
				requestRef: "fixture",
			};
		},
	};
	const mutable = structuredClone(input);
	const trial = await startTrial(
		mutable,
		{
			async infer(request) {
				if (!calls.length)
					return {
						output: {
							text: "現在の定義を確認し、確認票の作成を依頼します。",
							review: { question: "タイトルの照合", conditionIds: ["heading"] },
							skill: { goal: "確認票の作成", query: "予約フォーム 確認票" },
						},
						costUsd: 0,
					};
				expect(request.messages[1]?.content).toContain("RZ-47");
				artifact.resolve();
				return {
					output: { title: "確認票", body: "運用照合キー RZ-47" },
					costUsd: 0,
				};
			},
		},
		services,
		signal,
	);
	expect(trial.reply).toContain("確認票");
	expect(calls).toEqual([]);
	mutable.work.version = "2";
	const pending = trial.runBackground();
	try {
		await reviewing.promise;
		await artifact.promise;
		expect(trial.runBackground()).toBe(pending);
	} finally {
		release.resolve();
	}
	const result = await pending;
	expect(result.review?.status).toBe("ok");
	expect(result.skill?.status).toBe("ok");
	expect(calls).toEqual(["review", "skill"]);
});

test("optional calls remain absent when the model returns no requests", async () => {
	const trial = await startTrial(
		input,
		{
			async infer() {
				return {
					output: {
						text: "確認しました。",
						review: null,
						skill: null,
						research: null,
					},
					costUsd: 0,
				};
			},
		},
		{
			skillCatalog: ["業務用の引継ぎ様式"],
			async review() {
				throw Error("unexpected_review");
			},
			async skill() {
				throw Error("unexpected_skill");
			},
			async research() {
				throw Error("unexpected_research");
			},
		},
		AbortSignal.timeout(1000),
	);
	expect(await trial.runBackground()).toEqual({
		review: null,
		skill: null,
		research: null,
	});
});

test("three sentences preserve valid review and artifact work", async () => {
	let modelCalls = 0;
	let reviewCalls = 0;
	const trial = await startTrial(
		input,
		{
			async infer() {
				if (++modelCalls === 1)
					return {
						output: {
							text: "依頼を受け付けました。定義を照合します。確認票を作ります。",
							review: { question: "タイトルの照合", conditionIds: ["heading"] },
							skill: null,
						},
						costUsd: 0,
					};
				return { output: { title: "確認票", body: "成果物" }, costUsd: 0 };
			},
		},
		{
			async review() {
				reviewCalls++;
				return { status: "completed" };
			},
		},
		AbortSignal.timeout(2000),
		true,
	);
	expect(trial.replyStyle).toEqual({
		sentences: 3,
		sentenceLimitExceeded: true,
	});
	expect((await trial.runBackground()).artifact).toMatchObject({
		status: "ok",
	});
	expect(reviewCalls).toBe(1);
	expect(modelCalls).toBe(2);
});

test("the comparison produces artifacts in both arms and uses only completed support", async () => {
	for (const assisted of [false, true]) {
		let calls = 0;
		const trial = await startTrial(
			input,
			{
				async infer(request) {
					if (++calls === 1)
						return {
							output: {
								text: "確認票を作ります。",
								review: assisted
									? { question: "タイトルを照合", conditionIds: ["heading"] }
									: null,
								skill: assisted ? { goal: "確認票", query: "確認票" } : null,
							},
							costUsd: 0,
						};
					const reference = request.messages[1]!.content;
					expect(reference.includes("REVIEW-FINDING")).toBe(assisted);
					expect(reference).not.toContain("UNDELIVERED-SKILL");
					return { output: { title: "確認票", body: "成果物" }, costUsd: 0 };
				},
			},
			assisted
				? {
						async review() {
							return { status: "completed", findings: ["REVIEW-FINDING"] };
						},
						async skill() {
							throw Error("UNDELIVERED-SKILL");
						},
					}
				: {},
			AbortSignal.timeout(2000),
			true,
		);
		expect((await trial.runBackground()).artifact).toMatchObject({
			status: "ok",
		});
		expect(calls).toBe(2);
	}
});

test("background public research starts after the reply and supplies sources to the artifact", async () => {
	let modelCalls = 0;
	let searches = 0;
	const source = {
		url: "https://sqlite.org/foreignkeys.html",
		title: "SQLite foreign keys",
		snippet: "See the foreign key support documentation.",
	};
	const trial = await startTrial(
		input,
		{
			async infer(request) {
				if (++modelCalls === 1)
					return {
						output: {
							text: "公開資料を確認して確認票にまとめます。",
							review: null,
							skill: null,
							research: {
								goal: "SQLiteの仕様を確認",
								query: "SQLite foreign keys",
							},
						},
						costUsd: 0,
					};
				expect(request.messages[1]?.content).toContain(source.url);
				return { output: { title: "確認票", body: source.url }, costUsd: 0 };
			},
		},
		{
			async research(task) {
				searches++;
				expect(task.query).toBe("SQLite foreign keys");
				return { sources: [source] };
			},
		},
		AbortSignal.timeout(1000),
		true,
	);
	expect(searches).toBe(0);
	const background = trial.runBackground();
	expect(trial.runBackground()).toBe(background);
	const result = await background;
	expect(searches).toBe(1);
	expect(result.research).toMatchObject({
		status: "ok",
		value: { sources: [source] },
	});
	expect(result.artifact).toMatchObject({
		status: "ok",
		value: { body: source.url },
	});
});

test("a failed background lookup is visible to the artifact writer", async () => {
	let calls = 0;
	const trial = await startTrial(
		input,
		{
			async infer(request) {
				if (++calls === 1)
					return {
						output: {
							text: "公開資料を確認します。",
							review: null,
							skill: null,
							research: { goal: "仕様を確認", query: "public specification" },
						},
						costUsd: 0,
					};
				expect(request.messages[1]?.content).toContain(
					'"research":{"status":"unavailable"}',
				);
				return {
					output: { title: "確認票", body: "出典を確認できませんでした。" },
					costUsd: 0,
				};
			},
		},
		{
			async research() {
				throw new Error("research_failed");
			},
		},
		AbortSignal.timeout(1000),
		true,
	);
	const result = await trial.runBackground();
	expect(result.research?.status).toBe("failed");
	expect(result.artifact?.status).toBe("ok");
});
