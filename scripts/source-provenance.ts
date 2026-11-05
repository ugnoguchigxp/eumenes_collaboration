/** A generated manifest is excluded; every other nonignored working-tree change invalidates a commit-only claim. */
export function sourceProvenance(root: string) {
	const head = Bun.spawnSync(["git", "rev-parse", "--verify", "HEAD"], {
		cwd: root,
	});
	const sourceBaseCommit =
		head.exitCode === 0 ? head.stdout.toString().trim() : null;
	if (!sourceBaseCommit)
		return { sourceCommit: null, sourceBaseCommit, sourceTreeDirty: null };
	const status = Bun.spawnSync(
		[
			"git",
			"status",
			"--porcelain=v1",
			"--untracked-files=all",
			"--",
			".",
			":(exclude)manifest.json",
		],
		{ cwd: root },
	);
	const sourceTreeDirty =
		status.exitCode === 0 ? status.stdout.length > 0 : null;
	return {
		sourceCommit: sourceTreeDirty === false ? sourceBaseCommit : null,
		sourceBaseCommit,
		sourceTreeDirty,
	};
}
