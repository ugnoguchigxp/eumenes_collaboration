import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { gzipSync, gunzipSync } from "node:zlib";
import { parseTasks } from "./tasks-v2.ts";
import { guardAdoption, summarize, type Protocol } from "./summarize-v2.ts";

const MAX_BYTES = 32 * 1024 * 1024;
const FILES = [
	"tasks.json",
	"protocol.json",
	"live-protocol.json",
	"api-budget-summary.json",
	"live.jsonl.gz",
] as const;
const hash = (bytes: string | Uint8Array) =>
	createHash("sha256").update(bytes).digest("hex");

/** Archive completed synthetic evidence only. Explicit paths, never paths taken from untrusted run metadata. */
export async function archiveEvaluation(input: {
	runDir: string;
	destination: string;
	tasks: string;
	protocol: string;
}) {
	const [tasks, protocol, liveProtocol, budget, raw, summary] =
		await Promise.all([
			readFile(input.tasks),
			readFile(input.protocol),
			readFile(join(input.runDir, "live-protocol.json")),
			readFile(join(input.runDir, "api-budget-summary.json")),
			readFile(join(input.runDir, "live.jsonl")),
			readFile(join(input.runDir, "summary-v2.json")),
		]);
	for (const bytes of [tasks, protocol, liveProtocol, budget, raw, summary])
		if (bytes.length > MAX_BYTES)
			throw new Error("evaluation_archive_capacity_exceeded");
	parseTasks(JSON.parse(tasks.toString()));
	const recorded = JSON.parse(liveProtocol.toString());
	if (
		hash(tasks) !== recorded.tasksSha256 ||
		hash(protocol) !== recorded.preregistration?.sha256 ||
		hash(raw) !== JSON.parse(summary.toString()).rawLogSha256
	)
		throw new Error("evaluation_archive_source_mismatch");
	const bodies = [tasks, protocol, liveProtocol, budget, gzipSync(raw)];
	// Refuse an existing destination rather than merging evidence from two runs.
	await mkdir(input.destination, { recursive: false });
	for (const [i, name] of FILES.entries())
		await writeFile(join(input.destination, name), bodies[i]!);
	await writeFile(
		join(input.destination, "manifest.json"),
		JSON.stringify(
			{
				version: 1,
				synthetic: true,
				run: recorded.runName,
				rawLogSha256: hash(raw),
				files: Object.fromEntries(
					FILES.map((name, i) => [name, hash(bodies[i]!)]),
				),
			},
			null,
			2,
		) + "\n",
	);
	return summarizeArchive(input.destination);
}

/** Verify and re-summarize an archive offline. No provider adapter, credential or stored absolute path is used. */
export async function summarizeArchive(directory: string) {
	const manifest = JSON.parse(
		await readFile(join(directory, "manifest.json"), "utf8"),
	);
	if (
		manifest.version !== 1 ||
		manifest.synthetic !== true ||
		JSON.stringify(Object.keys(manifest.files).sort()) !==
			JSON.stringify([...FILES].sort())
	)
		throw new Error("evaluation_archive_manifest_invalid");
	const bodies = await Promise.all(
		FILES.map(async (name) => {
			const bytes = await readFile(join(directory, name));
			if (bytes.length > MAX_BYTES)
				throw new Error("evaluation_archive_capacity_exceeded");
			if (hash(bytes) !== manifest.files[name])
				throw new Error("evaluation_archive_digest_mismatch");
			return bytes;
		}),
	);
	const [tasksBytes, ruleBytes, protocolBytes, budgetBytes, compressed] =
		bodies;
	const tasks = parseTasks(JSON.parse(tasksBytes!.toString()));
	const liveProtocol = JSON.parse(protocolBytes!.toString());
	const raw = gunzipSync(compressed!, { maxOutputLength: MAX_BYTES });
	if (
		hash(raw) !== manifest.rawLogSha256 ||
		hash(tasksBytes!) !== liveProtocol.tasksSha256 ||
		hash(ruleBytes!) !== liveProtocol.preregistration?.sha256
	)
		throw new Error("evaluation_archive_source_mismatch");
	const records = raw
		.toString()
		.trim()
		.split("\n")
		.map((line) => JSON.parse(line));
	const rule = JSON.parse(ruleBytes!.toString()) as Protocol;
	const result = {
		run: manifest.run,
		dryRun: liveProtocol.dryRun === true,
		rawLogSha256: hash(raw),
		preregistration: { unchangedSinceRun: true },
		...summarize(records, rule, JSON.parse(budgetBytes!.toString())),
	};
	guardAdoption(result, liveProtocol, records);
	return { tasks: tasks.length, ...result };
}

if (import.meta.main) {
	try {
		const { values, positionals } = parseArgs({
			options: { tasks: { type: "string" }, protocol: { type: "string" } },
			allowPositionals: true,
			strict: true,
		});
		if (positionals.length === 1 && !values.tasks && !values.protocol) {
			console.log(
				JSON.stringify(
					await summarizeArchive(resolve(positionals[0]!)),
					null,
					2,
				),
			);
		} else if (positionals.length === 2 && values.tasks && values.protocol) {
			console.log(
				JSON.stringify(
					await archiveEvaluation({
						runDir: resolve(positionals[0]!),
						destination: resolve(positionals[1]!),
						tasks: resolve(values.tasks),
						protocol: resolve(values.protocol),
					}),
					null,
					2,
				),
			);
		} else
			throw new Error(
				"usage: archive.ts <archive-dir> OR <run-dir> <new-archive-dir> --tasks <file> --protocol <file>",
			);
	} catch (error) {
		console.error(
			error instanceof Error ? error.message : "evaluation_archive_failed",
		);
		process.exitCode = 1;
	}
}
