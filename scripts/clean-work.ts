import { lstat, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/** Throwaway copies made by hand or by verify-clean-copy; safe to delete with `--apply`. */
const temporaryPrefixes = [
	"clean-",
	"push-check-",
	"quality-pack-",
	"review-package-",
];
/** Read by other tools (eval/live.ts, pack-check); deleted only with `--all`. */
const protectedPrefixes = ["evaluation-baseline", "eumenes-"];
const protectedNames = ["host.tar"];

/**
 * Pick the entries of `.work/` to delete. Anything that matches neither list (loose scripts, notes) is never
 * selected, even with `all`. The `.work` directory itself is never a candidate.
 */
export function selectTargets(
	names: readonly string[],
	options: { all?: boolean } = {},
): string[] {
	return names.filter((name) => {
		if (!name || name === "." || name === ".." || /[\\/]/.test(name))
			return false;
		if (temporaryPrefixes.some((prefix) => name.startsWith(prefix)))
			return true;
		if (!options.all) return false;
		return (
			protectedNames.includes(name) ||
			protectedPrefixes.some((prefix) => name.startsWith(prefix))
		);
	});
}

function sizeKiB(path: string): number {
	const du = Bun.spawnSync(["du", "-sk", path]);
	return du.exitCode === 0 ? Number(du.stdout.toString().split(/\s/)[0]) : 0;
}
function human(kib: number): string {
	if (kib >= 1024 * 1024) return `${(kib / 1024 / 1024).toFixed(1)}G`;
	if (kib >= 1024) return `${(kib / 1024).toFixed(1)}M`;
	return `${kib}K`;
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const apply = args.includes("--apply");
	const all = args.includes("--all");
	const unknown = args.filter((arg) => arg !== "--apply" && arg !== "--all");
	if (unknown.length) {
		console.error(`unknown arguments: ${unknown.join(" ")}`);
		console.error("usage: bun scripts/clean-work.ts [--apply] [--all]");
		process.exit(2);
	}
	const work = resolve(import.meta.dir, "..", ".work");
	const names = await readdir(work).catch(() => [] as string[]);
	const targets = selectTargets(names.sort(), { all });
	const kept = names.filter((name) => !targets.includes(name));
	let total = 0;
	console.log(
		`${apply ? "apply" : "dry-run"}${all ? " (--all)" : ""}: ${work}`,
	);
	for (const name of targets) {
		const size = sizeKiB(join(work, name));
		total += size;
		console.log(
			`  ${apply ? "delete" : "target"}  ${human(size).padStart(7)}  ${name}`,
		);
		if (apply) {
			// lstat first: a symlink is removed as a link, never followed.
			await lstat(join(work, name));
			await rm(join(work, name), { recursive: true, force: true });
		}
	}
	for (const name of kept) console.log(`  keep    ${" ".repeat(7)}  ${name}`);
	console.log(
		`${apply ? "deleted" : "would delete"}: ${targets.length} entries, ${human(total)}`,
	);
	if (!apply)
		console.log("nothing was deleted; pass --apply to delete the targets");
}
