import { expect, test } from "bun:test";
import { fixtureConnection, createServices } from "./services.mjs";
import { input, procedure } from "./scenario.ts";
import { startTrial } from "./session.ts";
import { cases } from "../../eval/proactive/luna/cases.mjs";

test("real MCP and Skill Smith deliver source-bound guidance, and Evaluator reviews the same work version", async () => {
	const signal = AbortSignal.timeout(10000);
	const connection = await fixtureConnection(procedure);
	const requests = [];
	try {
		const original = connection.fetch;
		connection.fetch = async (url, options) => {
			const { method, params } = JSON.parse(options.body);
			requests.push(params.name ?? method);
			return original(url, options);
		};
		let smithRounds = 0;
		let calls = 0;
		const services = await createServices(connection, async (lane, request) => {
			if (lane === "evaluator") {
				expect(request.timeoutMs).toBe(60_000);
				const packet = JSON.parse(request.messages[1].content);
				const evidence = {
					evidenceId: packet.evidence.find(
						(item) => item.pointerRoot === "/title",
					).id,
					pointer: "/title",
					startLine: null,
					endLine: null,
				};
				return {
					output: {
						scopeChecks: packet.scope.map((evidenceId) => ({
							evidenceId,
							verdict:
								evidenceId === evidence.evidenceId ? "differs" : "context",
							reason: "資料を照合",
							finding:
								evidenceId === evidence.evidenceId
									? {
											title: "タイトル不一致",
											problem: "現行と合意が異なります。",
											trigger: "画面を開く",
											impact: "表示名が違う",
											severity: "medium",
											evidence: [],
											conditionId: "heading",
										}
									: null,
						})),
						conditionChecks: [
							{
								conditionId: "heading",
								status: "violated",
								reason: "タイトルが申込フォーム",
								evidence: [evidence],
							},
						],
					},
					model: "fixture",
				};
			}
			smithRounds++;
			expect(request.stage).toBe("reuse-selection");
			const packet = JSON.parse(request.messages[1].content);
			const snapshot = packet.task.constraints.find(
				({ id }) => id === "work-snapshot",
			);
			expect(JSON.parse(snapshot.text)).toEqual({
				work: input.work,
				confirmedConditions: input.conditions,
			});
			expect(packet.task.acceptance.map(({ id }) => id)).toEqual([
				"deliverable",
				"fidelity",
				"procedure-fidelity",
			]);
			const [candidate] = packet.procedures;
			expect(candidate.ref).toStartWith("contextstill:");
			expect(candidate.body).toContain("RZ-47");
			return {
				output: {
					ref: candidate.ref,
					reason: "確認票の対象と定型欄が一致する。",
				},
			};
		});
		const trial = await startTrial(
			input,
			{
				async infer(request) {
					calls++;
					if (calls === 1) {
						expect(request.messages[1].content).toContain(procedure.title);
						expect(request.messages[1].content).not.toContain("RZ-47");
						return {
							output: {
								text: "確認を依頼し、運用担当向けの確認票を作ります。",
								review: {
									question: "タイトルの照合",
									conditionIds: ["heading"],
								},
								skill: {
									goal: "運用担当向け確認票を作る",
									query: "社内予約フォーム 運用担当 確認票",
								},
							},
							costUsd: 0,
						};
					}
					expect(request.messages[1].content).toContain("RZ-47");
					return {
						output: { title: "確認票", body: "運用照合キー RZ-47" },
						costUsd: 0,
					};
				},
			},
			services,
			signal,
		);
		expect(requests).toEqual([]);
		const result = await trial.runBackground();
		if (result.skill?.status !== "ok")
			throw Error(JSON.stringify(result.skill));
		expect(result.skill.value.work.value?.body).toContain("RZ-47");
		expect(result.skill.value.dependencies[0]).toMatchObject({ version: "1" });
		expect(smithRounds).toBe(1);
		expect(
			result.skill.value.sourceCalls.map(({ operation }) => operation),
		).toEqual(["search", "read", "validate", "validate"]);
		expect(result.review.value).toMatchObject({
			status: "completed",
			target: { version: "1" },
		});
		expect(requests.filter((name) => name === "search_knowledge")).toHaveLength(
			1,
		);
		expect(
			requests.filter((name) => name === "get_knowledge").length,
		).toBeGreaterThan(1);
	} finally {
		await connection.close();
	}
}, 15000);

test("exact reuse rejects a source that changes after applicability selection", async () => {
	const connection = await fixtureConnection(procedure);
	try {
		const original = connection.fetch;
		let selected = false;
		connection.fetch = async (url, options) => {
			const response = await original(url, options);
			const { params } = JSON.parse(options.body);
			if (!selected || params?.name !== "get_knowledge") return response;
			const envelope = await response.json();
			const payload = JSON.parse(envelope.result.content[0].text);
			payload.item.body += "版の変更";
			envelope.result.content[0].text = JSON.stringify(payload);
			return Response.json(envelope);
		};
		const services = await createServices(
			connection,
			async (_lane, request) => {
				const [candidate] = JSON.parse(request.messages[1].content).procedures;
				selected = true;
				return {
					output: { ref: candidate.ref, reason: "対象と目的が一致する。" },
				};
			},
		);
		await expect(
			services.skill(
				input,
				{
					goal: "運用担当向け確認票を作る",
					query: "予約フォーム 運用担当 確認票",
				},
				AbortSignal.timeout(5000),
			),
		).rejects.toThrow("source_revoked");
	} finally {
		await connection.close();
	}
});

test("review covers each row and retains both violations of the same condition", async () => {
	const connection = await fixtureConnection([]);
	try {
		let omitLastRow = true;
		const input = cases[1].input;
		const services = await createServices(
			connection,
			async (lane, request) => {
				expect(lane).toBe("evaluator");
				expect(request.timeoutMs).toBe(120_000);
				const packet = JSON.parse(request.messages[1].content);
				expect(packet.originalRequest).toBe(input.utterance);
				expect(packet.evidence.map(({ pointerRoot }) => pointerRoot)).toEqual([
					"/rules/0",
					"/rules/1",
					"/rules/2",
					"/rules/3",
				]);
				const violations = omitLastRow ? [1] : [1, 3];
				const evidence = violations.map((index) => ({
					evidenceId: packet.evidence[index].id,
					pointer: "/rules/" + index + "/send",
					startLine: null,
					endLine: null,
				}));
				return {
					model: "fixture",
					output: {
						scopeChecks: packet.scope
							.slice(0, omitLastRow ? 3 : 4)
							.map((evidenceId, index) => ({
								evidenceId,
								verdict: violations.includes(index) ? "differs" : "matches",
								reason: "現行と期待を照合",
								finding:
									violations.includes(index) || index === 0
										? {
												title: "誤った送信設定",
												problem: "送信条件を満たさない",
												trigger: "現在の設定を適用",
												impact: "通知の誤送信",
												severity: "high",
												evidence: [],
												conditionId: "gate",
											}
										: null,
							})),
						conditionChecks: [
							{
								conditionId: "gate",
								status: "violated",
								reason: "許可条件を満たさない送信がある",
								evidence,
							},
						],
					},
				};
			},
			{ evaluatorTimeoutMs: 120_000 },
		);
		const selection = {
			question: "各行の現行と期待を照合",
			conditionIds: ["gate"],
		};
		const signal = AbortSignal.timeout(5000);
		const partial = await services.review(input, selection, signal);
		expect(partial.status).toBe("incomplete");
		expect(partial.issues).toContainEqual({ code: "scope_unverified" });
		omitLastRow = false;
		const complete = await services.review(input, selection, signal);
		expect(complete.status).toBe("completed");
		expect(complete.findings.map((finding) => finding.primary.pointer)).toEqual(
			["/rules/1", "/rules/3"],
		);
	} finally {
		await connection.close();
	}
});

test("a declared comparison sends the allowed ledgers and uses Evaluator's row contract", async () => {
	const connection = await fixtureConnection([]);
	try {
		const work = {
			id: "dispatch",
			version: "1",
			document: {
				results: [
					{ id: "a", current: "STOP" },
					{ id: "b", current: "GO" },
				],
				"source/ledger": { "a~b": { ready: false } },
				privateNote: "outside the selected evidence",
			},
		};
		const input = {
			utterance: "記録を台帳と照合する。",
			work,
			conditions: [{ id: "gate", text: "準備済みの行だけGOにする。" }],
			reviewComparison: {
				rowsField: "results",
				sourceFields: ["source/ledger"],
				currentValuePointer: "/current",
				rowLabelPointer: "/id",
				expectedValues: ["GO", "STOP"],
			},
		};
		let omitLast = true;
		const services = await createServices(
			connection,
			async (lane, request) => {
				expect(lane).toBe("evaluator");
				expect(request.timeoutMs).toBe(120_000);
				expect(request.outputSchema.required).toEqual(["rows", "conditions"]);
				expect(request.messages[0].content).toContain("関連資料を横断");
				const packet = JSON.parse(request.messages[1].content);
				expect(packet.comparisonPointers).toEqual([
					"/results/0/current",
					"/results/1/current",
				]);
				expect(packet.expectedValues).toEqual(["GO", "STOP"]);
				expect(
					packet.evidence.filter(
						({ pointerRoot }) => pointerRoot === undefined,
					),
				).toMatchObject([
					{
						id: "/source~1ledger/a~0b",
						document: { ready: false },
						version: "1",
					},
				]);
				const evidence = [
					{ evidenceId: "/source~1ledger/a~0b", pointer: null },
				];
				return {
					model: "fixture",
					inputTokens: 10,
					outputTokens: 5,
					output: {
						rows: packet.comparisonPointers
							.slice(0, omitLast ? 1 : 2)
							.map((pointer, index) => ({
								pointer,
								evidence,
								basis: {
									comparisons: [],
									decision: null,
									dependencies: [],
									facts: "台帳で準備が未完了",
									value: "STOP",
									via: null,
								},
								conditionId: index === 0 ? null : "gate",
							})),
						conditions: [
							{
								conditionId: "gate",
								verified: true,
								reason: "台帳で確認",
								evidence,
							},
						],
					},
				};
			},
			{ evaluatorTimeoutMs: 120_000 },
		);
		const selection = {
			question: "現行コードと台帳を照合",
			conditionIds: ["gate"],
		};
		const signal = AbortSignal.timeout(5000);
		const partial = await services.review(input, selection, signal);
		expect(partial.status).toBe("incomplete");
		expect(partial.issues).toContainEqual({ code: "scope_unverified" });
		omitLast = false;
		const complete = await services.review(input, selection, signal);
		expect(complete.status).toBe("completed");
		expect(complete.findings.map(({ primary }) => primary.pointer)).toEqual([
			"/results/1/current",
		]);
		expect(complete.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
	} finally {
		await connection.close();
	}
});
