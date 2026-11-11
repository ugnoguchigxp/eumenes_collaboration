import { expect, test } from "bun:test";
import { z } from "zod";
import {
	createCollaborationContract,
	createStatefulCollaborationContract,
	proposeStateUpdate,
} from "../src/index.ts";
import { exampleReplyPolicy } from "../example/host.ts";
import { host, initial, proposal } from "./state.fixture.ts";

test("an opt-in turn shares the inference/action budget while the legacy action contract remains strict", () => {
	const contract = createStatefulCollaborationContract(exampleReplyPolicy);
	const output = {
		action: "reply",
		text: "条件を保持しました。",
		stateUpdate: proposal(),
	};
	expect(
		createCollaborationContract(exampleReplyPolicy).parse(output),
	).toBeNull();
	const checked = contract.check(output);
	expect(checked.ok).toBe(true);
	if (checked.ok) {
		expect(checked.action.kind).toBe("reply");
		expect(proposeStateUpdate(initial(), checked.proposal, host()).ok).toBe(
			true,
		);
	}
	expect(
		contract.check({ action: "reply", text: "保存済みです。" }),
	).toMatchObject({ ok: false, reason: "proposal_invalid" });
	expect(contract.check({ ...output, tool: "unregistered" }).ok).toBe(false);
});

test("the combined model schema preserves recursive JSON references at the root", () => {
	const contract = createStatefulCollaborationContract(exampleReplyPolicy);
	const validator = z.fromJSONSchema(contract.outputSchema);
	const p = proposal();
	p.upserts[0]!.value = { items: [1, false, null, { nested: "値" }] };
	expect(
		validator.safeParse({
			action: "reply",
			text: "確認します。",
			stateUpdate: p,
		}).success,
	).toBe(true);
});
