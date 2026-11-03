import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureWorkflow } from "../scenario.ts";
import { observeCurrent } from "../adapters/observation.ts";

test("full example: model proposal, atomic adoption, correction, reopen, replay, forgetting", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-workflow-"));
	try {
		const result = await runFixtureWorkflow(join(dir, "state.sqlite"));
		expect(result.replay).toMatchObject({
			ok: true,
			replay: true,
			revision: 2,
		});
		expect(result.state.facts).toHaveLength(1);
		expect(result.state.facts[0]).toMatchObject({
			id: "department-v2",
			sourceRefs: ["u2"],
			supersedes: [],
			value: { value: false },
		});
		expect(JSON.stringify(result.state)).not.toContain("email-v1");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("UI and Pipeline observations bind to their own revision and reject a concurrent edit", async () => {
	for (const ref of ["ui:form", "pipeline:flow"]) {
		let current = { ref, revision: 1, digest: "one" };
		const observation = {
			ref: "observation:1",
			work: { ...current },
			capturedAt: "2026-11-04T12:00:00+09:00",
			kind: "validation" as const,
			evidence: "fixture" as const,
			result: { ok: true },
		};
		expect(
			await observeCurrent({
				current: () => current,
				async capture() {
					return observation;
				},
			}),
		).toMatchObject({
			status: "current",
			observation: { evidence: "fixture" },
		});
		expect(
			await observeCurrent({
				current: () => current,
				async capture() {
					current = { ...current, revision: 2, digest: "two" };
					return observation;
				},
			}),
		).toMatchObject({ status: "stale", current: { revision: 2 } });
	}
});
