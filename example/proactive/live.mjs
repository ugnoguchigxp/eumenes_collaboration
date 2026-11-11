import { open } from "node:fs/promises";
import { createTrialModel } from "./codex.mjs";
import { input, procedure } from "./scenario.ts";
import { createServices, fixtureConnection } from "./services.mjs";
import { startTrial } from "./session.ts";

const [host, model, output] = Bun.argv.slice(2);
if (!host || !model || !output) {
	throw new Error(
		"usage: bun example/proactive/live.mjs <isolated-eumenes-copy> <model> <new-output>",
	);
}
const file = await open(output, "wx", 0o600);
const calls = [];
const maxCalls = 6;
const signal = AbortSignal.timeout(180000);
const complete = await createTrialModel(host, model, calls, maxCalls, signal);

const result = { model, route: "codex-subscription", maxCalls, calls };
try {
	const fixture = await fixtureConnection(procedure);
	try {
		const services = await createServices(fixture, complete);
		const trial = await startTrial(
			input,
			{
				infer: (request) =>
					complete(calls.length ? "skill-worker" : "reply", request),
			},
			services,
			signal,
		);
		Object.assign(result, {
			reply: trial.reply,
			replyMs: trial.replyMs,
			requests: trial.requests,
		});
		console.log(
			JSON.stringify({ reply: trial.reply, elapsedMs: trial.replyMs }),
		);
		const background = await trial.runBackground();
		Object.assign(result, { background });
		const review = background.review?.value;
		const skill = background.skill?.value;
		const artifact = skill?.work?.value;
		const deliveredMarker = [
			skill?.skill.content,
			...(skill?.skill.files ?? []).map(({ content }) => content),
		].some((content) => content?.includes("RZ-47"));
		const checks = {
			review:
				review?.status === "completed" &&
				review.findings.some(
					(finding) =>
						finding.conditionId === "heading" &&
						finding.primary.pointer === "/title",
				),
			skill: Boolean(skill?.dependencies.length && deliveredMarker),
			applied: Boolean(artifact?.body.includes("RZ-47")),
			task: Boolean(
				artifact?.body.includes("予約フォーム") &&
				artifact.body.includes("申込フォーム") &&
				artifact.body.includes("部署") &&
				artifact.body.includes("備考"),
			),
		};
		result.checks = checks;
		if (!Object.values(checks).every(Boolean))
			throw new Error("trial_acceptance_failed");
	} finally {
		await fixture.close();
	}
} catch (error) {
	result.error = error instanceof Error ? error.message : String(error);
	process.exitCode = 1;
} finally {
	try {
		await file.writeFile(JSON.stringify(result, null, 2) + "\n");
	} finally {
		await file.close();
	}
}
