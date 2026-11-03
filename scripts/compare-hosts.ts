import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

export async function compareHosts(baseline: string, candidate: string) {
	const moduleAt = (root: string, name: string) =>
		import(
			pathToFileURL(join(root, "api/domains/dialogue/service", name)).href
		);
	const old = await moduleAt(baseline, "specialist-prompt.ts");
	const next = await moduleAt(candidate, "specialist-prompt.ts");
	let comparisons = 0;
	const same = (label: string, a: unknown, b: unknown) => {
		if (!isDeepStrictEqual(a, b)) throw new Error(`parity_failed:${label}`);
		comparisons++;
	};
	const outputs: unknown[] = [null, [], "bad", {}, { action: "unknown" }];
	for (const action of ["reply", "invoke", "return", "discard"]) {
		for (const text of [
			undefined,
			"",
			"短い返答",
			"一。二。三。",
			"あ".repeat(301),
			42,
		]) {
			for (const fields of [
				{},
				{ tool: "doc.edit" },
				{ forward: false },
				{ tool: "doc.edit", forward: true },
				{ arguments: { a: 1 } },
				{ extra: "untrusted" },
			])
				outputs.push({
					action,
					...(text === undefined ? {} : { text }),
					...fields,
				});
		}
	}
	for (const output of outputs) {
		same(
			"action",
			old.parseSpecialistAction(output),
			next.parseSpecialistAction(output),
		);
		const violations = old.specialistViolations(output);
		same("violations", violations, next.specialistViolations(output));
		same(
			"names",
			old.violationNames(violations),
			next.violationNames(violations),
		);
		same(
			"correction",
			old.correctionMessage(JSON.stringify(output), violations, 2),
			next.correctionMessage(JSON.stringify(output), violations, 2),
		);
	}
	const set = {
		profile: "専門担当",
		skills: ["host SKILL"],
		tools: [{ id: "work.edit", summary: "編集", schema: { type: "object" } }],
	};
	same(
		"control/schema/instructions",
		old.specialistControl(set),
		next.specialistControl(set),
	);
	const oldMemory = await moduleAt(baseline, "specialist-memory.ts");
	const nextMemory = await moduleAt(candidate, "specialist-memory.ts");
	for (const interrupted of [null, "中断された原文"])
		for (const document of [
			undefined,
			{
				path: "work.json",
				revision: 4,
				title: "現在",
				outlined: false,
				body: '{"手編集":true}',
				inlineBytes: 2,
				rejected: {
					title: "案",
					text: "あ",
					issues: [{ path: "a", rule: "required" }],
					fixes: [],
					createdAt: "2026-11-04T00:00:00+09:00",
				},
			},
		]) {
			const input = {
				system: { role: "system", content: "固定指示" },
				utterance: "利用者の原文",
				course: {
					course: [
						{
							utterance: "前の依頼",
							outcome: "failed",
							steps: [{ tool: "doc.edit", ok: true, revision: 2 }],
						},
					],
					interrupted,
					handedOver: "引継ぎ",
				},
				work: {
					label: "作品",
					dirty: true,
					current: { a: 1 },
					context: { choices: ["実在する項目"] },
					savedRef: "work:1",
				},
				viewing: { toolchainId: "host", ref: "other:1", label: "別作品" },
				nowMs: 1793746800000,
				callsLeft: 4,
				...(document ? { document } : {}),
			};
			same(
				"messages",
				oldMemory.specialistTurnMessages(input),
				nextMemory.specialistTurnMessages(input),
			);
		}
	return { outputs: outputs.length, comparisons };
}
