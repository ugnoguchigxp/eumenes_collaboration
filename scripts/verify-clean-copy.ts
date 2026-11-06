import { randomBytes } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { childEnv } from "./child-env.ts";

/**
 * Verify a committed state without the working tree's uncommitted changes: extract `<commit>` (default HEAD)
 * with `git archive` into `.work/clean-<short>-<random>`, then run `bun install --frozen-lockfile` and
 * `bun run verify` there. The copy is deleted on success, kept on failure (and with `KEEP_WORK=1`).
 * Prints one JSON line on stdout; child output goes to `<copy>/.verify-<step>.log`.
 */
const root = resolve(import.meta.dir, "..");
const requested = process.argv[2] ?? "HEAD";
const keepAlways = process.env.KEEP_WORK === "1";
const steps: Array<{ name: string; exitCode: number }> = [];
let dir: string | null = null;
let commit: string | null = null;
let status: "passed" | "failed" = "failed";
let error: string | undefined;

function git(...args: string[]) {
	return Bun.spawnSync(["git", "-C", root, ...args], {
		env: childEnv(process.env),
	});
}
async function step(name: string, args: string[], cwd: string) {
	const proc = Bun.spawn(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: childEnv(process.env),
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	await Bun.write(join(cwd, `.verify-${name}.log`), stdout + stderr);
	steps.push({ name, exitCode });
	if (exitCode !== 0)
		throw new Error(`${name}_failed:see ${cwd}/.verify-${name}.log`);
}

try {
	const full = git("rev-parse", "--verify", "--quiet", `${requested}^{commit}`);
	if (full.exitCode) throw new Error(`unknown_commit:${requested}`);
	commit = full.stdout.toString().trim();
	const short = git("rev-parse", "--short=7", commit).stdout.toString().trim();
	dir = join(root, ".work", `clean-${short}-${randomBytes(4).toString("hex")}`);
	await mkdir(dir, { recursive: true });
	const archive = git("archive", "--format=tar", commit);
	if (archive.exitCode) throw new Error("archive_failed");
	const extract = Bun.spawnSync(["tar", "-xf", "-", "-C", dir], {
		stdin: archive.stdout,
	});
	if (extract.exitCode) throw new Error("extract_failed");
	// The copy lives under this repo's `.work/`, which `.gitignore` excludes; without a repository of its own,
	// oxlint inherits that parent ignore and finds no files to lint.
	await step("git-init", ["git", "init", "-q", "-b", "main"], dir);
	await step("install", ["bun", "install", "--frozen-lockfile"], dir);
	await step("verify", ["bun", "run", "verify"], dir);
	status = "passed";
} catch (caught) {
	error = String(caught);
	process.exitCode = 1;
} finally {
	// Remove only the directory this run created; keep it when it failed or KEEP_WORK=1.
	const kept = dir !== null && (status !== "passed" || keepAlways);
	if (dir && !kept) await rm(dir, { recursive: true, force: true });
	console.log(
		JSON.stringify({
			status,
			commit,
			dir: kept ? dir : null,
			kept,
			steps,
			error,
		}),
	);
}
