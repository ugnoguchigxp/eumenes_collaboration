import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sourceProvenance } from "../scripts/source-provenance.ts";

test("artifact provenance never labels dirty or untracked source as a clean commit", async () => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-provenance-"));
	const git = (...args: string[]) => {
		const result = Bun.spawnSync(
			[
				"git",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"user.name=Fixture",
				"-c",
				"user.email=fixture@invalid",
				...args,
			],
			{ cwd: dir },
		);
		if (result.exitCode !== 0) throw new Error("fixture_git_failed");
		return result.stdout.toString().trim();
	};
	try {
		expect(sourceProvenance(dir).sourceCommit).toBeNull();
		git("init", "-b", "main");
		await Bun.write(join(dir, "code.ts"), "export const value = 1;\n");
		await Bun.write(join(dir, "manifest.json"), "{}\n");
		git("add", ".");
		git("commit", "-m", "fixture");
		const head = git("rev-parse", "HEAD");
		expect(sourceProvenance(dir)).toEqual({
			sourceCommit: head,
			sourceBaseCommit: head,
			sourceTreeDirty: false,
		});
		await Bun.write(join(dir, "manifest.json"), '{"generated":true}\n');
		expect(sourceProvenance(dir).sourceCommit).toBe(head);
		await Bun.write(join(dir, "code.ts"), "export const value = 2;\n");
		expect(sourceProvenance(dir)).toEqual({
			sourceCommit: null,
			sourceBaseCommit: head,
			sourceTreeDirty: true,
		});
		git("checkout", "--", "code.ts");
		await Bun.write(join(dir, "new-source.ts"), "export {};\n");
		expect(sourceProvenance(dir).sourceCommit).toBeNull();
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
});
