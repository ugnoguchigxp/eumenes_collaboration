import type {
	CollaborationState,
	StateHostContext,
	StateProposal,
} from "eumenes-collaboration";
import { createFixtureModel } from "./adapters/model.ts";
import { proposeFacts } from "./state-turn.ts";
import { ExampleStateStore } from "./state-store.ts";

/** Fixed outputs exercise the same model/host boundary as live inference, without evaluating meaning. */
export async function runFixtureWorkflow(path: string) {
	let store = new ExampleStateStore(path);
	const work = { ref: "work:form", revision: 0, digest: "empty" };
	const initial: CollaborationState = {
		stateSchemaVersion: 1,
		coreContractVersion: 1,
		packageVersion: "0.1.0",
		sessionId: "example",
		revision: 0,
		sourceRevision: 1,
		work,
		facts: [],
	};
	const host: StateHostContext = {
		sessionId: "example",
		epoch: 1,
		sourceRevision: 1,
		work,
		sources: [
			{ ref: "u1", kind: "user", active: true },
			{ ref: "u2", kind: "user", active: true },
		],
	};
	const first: StateProposal = {
		coreContractVersion: 1,
		sessionId: "example",
		epoch: 1,
		expectedRevision: 0,
		sourceRevision: 1,
		work,
		upserts: [
			{
				id: "department-v1",
				kind: "condition",
				status: "confirmed",
				value: { path: "/department/required", value: true },
				sourceRefs: ["u1"],
				supersedes: [],
			},
			{
				id: "email-v1",
				kind: "condition",
				status: "confirmed",
				value: { path: "/email/enabled", value: false },
				sourceRefs: ["u1"],
				supersedes: [],
			},
		],
		removals: [],
	};
	const second: StateProposal = {
		...first,
		expectedRevision: 1,
		upserts: [
			{
				id: "department-v2",
				kind: "condition",
				status: "confirmed",
				value: { path: "/department/required", value: false },
				sourceRefs: ["u2"],
				supersedes: ["department-v1"],
			},
		],
	};
	try {
		store.initialize(initial, 1);
		const model = createFixtureModel([first, second]);
		for (const [index, utterance] of [
			"部署は必須でメールは不要",
			"部署を任意に訂正",
		].entries()) {
			const result = await proposeFacts(
				model,
				{
					utterance,
					course: { course: [], interrupted: null, handedOver: null },
					work: {
						label: "申込項目",
						dirty: false,
						current: {},
						savedRef: null,
					},
					viewing: null,
					time: { now: "2026-11-04T12:00:00+09:00", timeZone: "Asia/Tokyo" },
					callsLeft: 4,
				},
				store.read("example"),
				host,
				[{ ref: `u${index + 1}`, text: utterance }],
				new AbortController().signal,
			);
			if (!result.ok) throw new Error(result.reason);
			const receipt = store.adopt(
				"example",
				`op${index + 1}`,
				result.proposal,
				host,
			);
			if (!receipt.ok) throw new Error(receipt.reason);
		}
		store.close();
		store = new ExampleStateStore(path);
		const replay = store.adopt("example", "op2", second, host);
		const state = store.forget("example", new Set(["u1"]), 2);
		return { mode: "fixture" as const, replay, state };
	} finally {
		store.close();
	}
}
