import { expect, test } from "bun:test";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { summarizeArchive } from "../eval/archive.ts";

const archive = join(import.meta.dir, "../eval/results/2026-11-06/holdout-v2");
test("the retained holdout reconstructs historical results without scratchpad paths or provider access", async () => {
	const dir = await mkdtemp(join(tmpdir(), "evaluation-archive-"));
	try {
		await cp(archive, dir, { recursive: true });
		const result = await summarizeArchive(dir);
		expect(result.tasks).toBe(30);
		expect(result.rawLogSha256).toBe(
			"" +
				JSON.parse(await readFile(join(dir, "manifest.json"), "utf8"))
					.rawLogSha256,
		);
		expect(
			result.matrix.map((cell) => (cell.primary as { passed: number }).passed),
		).toEqual([27, 28, 29, 29]);
		await writeFile(join(dir, "protocol.json"), "{}");
		await expect(summarizeArchive(dir)).rejects.toThrow(
			"evaluation_archive_digest_mismatch",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});

test("archive manifests cannot redirect reads to arbitrary files", async () => {
	const dir = await mkdtemp(join(tmpdir(), "evaluation-manifest-"));
	try {
		await writeFile(
			join(dir, "manifest.json"),
			JSON.stringify({
				version: 1,
				synthetic: true,
				files: { "../../secrets": "a" },
			}),
		);
		await expect(summarizeArchive(dir)).rejects.toThrow(
			"evaluation_archive_manifest_invalid",
		);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
