import { writeFile } from "node:fs/promises";
import { createTrialModel } from "./codex.mjs";
import { createResearchService } from "./research.mjs";
import { startTrial } from "./session.ts";

const [host, output] = Bun.argv.slice(2);
if (!host || !output)
	throw new Error(
		"usage: research-live.mjs <Eumenes checkout> <new JSON output>",
	);

const signal = AbortSignal.timeout(180_000);
const calls = [];
const complete = await createTrialModel(host, "gpt-6-luna", calls, 3, signal);
const research = await createResearchService(host, complete);
let first = true;
const trial = await startTrial(
	{
		utterance:
			"SQLiteの外部キー制約について、接続を開いた直後に通常有効かと、有効にするSQLを、日本語の短い引継ぎメモにまとめてください。公式ドキュメントを出典として添えてください。",
		work: {
			id: "sqlite-foreign-key-note",
			version: "1",
			document: { product: "SQLite" },
		},
		conditions: [],
	},
	{
		infer(request) {
			const lane = first ? "reply" : "artifact";
			first = false;
			return complete(lane, request);
		},
	},
	{ research },
	signal,
	true,
);
const started = performance.now();
const background = await trial.runBackground();
await writeFile(
	output,
	JSON.stringify(
		{
			model: "gpt-6-luna",
			reasoning: "low",
			reply: trial.reply,
			replyMs: trial.replyMs,
			requests: trial.requests,
			backgroundMs: Math.round(performance.now() - started),
			...background,
			calls,
		},
		null,
		2,
	) + "\n",
	{ flag: "wx" },
);
if (
	background.research?.status !== "ok" ||
	background.artifact?.status !== "ok"
)
	process.exitCode = 1;
