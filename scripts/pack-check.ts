import { createHash } from "node:crypto";
import { mkdir, rm, cp } from "node:fs/promises";
import { resolve, join } from "node:path";
import { applyHostAdapter } from "./host-adapter.ts";
import { compareHosts } from "./compare-hosts.ts";
import { sourceProvenance } from "./source-provenance.ts";
import {
	coreContractVersion,
	supportedStateSchemaVersions,
} from "../src/index.ts";

const root = resolve(import.meta.dir, "..");
const packageVersion = (await Bun.file(join(root, "package.json")).json())
	.version as string;
const source = resolve(process.env.EUMENES_SOURCE ?? join(root, "../eumenes"));
/** The host commit this package was last proven against (manifest, spec/verification.json). */
const declaredBaseline = "5bf5ca556ad45a9c8a6b72f81aae85f7505e505c";
/**
 * Baseline policy for parallel development (review 2026-11-05): the host and this package move together, so
 * `EUMENES_BASELINE_COMMIT` may name another host commit (or `HEAD`) to prove against; the report records
 * both. When the host checkout or the commit is absent, the host-integration stages are reported `skipped`
 * with the reason and the run ends `passed_package_only`, never `passed`. `PACK_CHECK_REQUIRE_HOST=1` (CI,
 * releases) turns that into a failure.
 */
const requestedBaseline =
	process.env.EUMENES_BASELINE_COMMIT || declaredBaseline;
function resolveBaseline():
	{ ok: true; commit: string } | { ok: false; reason: string } {
	const top = Bun.spawnSync([
		"git",
		"-C",
		source,
		"rev-parse",
		"--show-toplevel",
	]);
	if (top.exitCode)
		return { ok: false, reason: `host_source_absent:${source}` };
	const commit = Bun.spawnSync([
		"git",
		"-C",
		source,
		"rev-parse",
		"--verify",
		"--quiet",
		`${requestedBaseline}^{commit}`,
	]);
	if (commit.exitCode)
		return { ok: false, reason: `host_baseline_absent:${requestedBaseline}` };
	return { ok: true, commit: commit.stdout.toString().trim() };
}
const host = resolveBaseline();
const baselineCommit = host.ok ? host.commit : requestedBaseline;
const reportDir = join(root, "reports");
const baseline = join(root, ".work/eumenes-baseline");
const candidate = join(root, ".work/eumenes-candidate");
await mkdir(reportDir, { recursive: true });
const report: {
	baselineCommit: string;
	steps: Array<{ name: string; exitCode: number; log: string }>;
	[key: string]: unknown;
} = { baselineCommit, declaredBaseline, steps: [] };
const digest = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
async function run(name: string, args: string[], cwd: string) {
	console.log(name);
	const proc = Bun.spawn(args, {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, TZ: "Asia/Tokyo" },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	const log = `${name}.log`;
	await Bun.write(join(reportDir, log), stdout + stderr);
	report.steps.push({ name, exitCode, log });
	await Bun.write(
		join(reportDir, "pack-check.json"),
		JSON.stringify(report, null, 2) + "\n",
	);
	if (exitCode !== 0) throw new Error(`${name}_failed:see_reports/${log}`);
	return stdout;
}
async function archiveTo(destination: string) {
	await rm(destination, { recursive: true, force: true });
	await mkdir(destination, { recursive: true });
	const archive = Bun.spawnSync([
		"git",
		"-C",
		source,
		"archive",
		baselineCommit,
	]);
	if (archive.exitCode) throw new Error("baseline_archive_failed");
	const path = join(root, ".work/host.tar");
	await Bun.write(path, archive.stdout);
	await run(
		"archive-" + destination.split("/").at(-1),
		["tar", "-xf", path, "-C", destination],
		root,
	);
	await run(
		"git-init-" + destination.split("/").at(-1),
		["git", "init", "-b", "main"],
		destination,
	);
	await run(
		"git-fetch-" + destination.split("/").at(-1),
		["git", "fetch", "--depth=1", "--no-tags", source, baselineCommit],
		destination,
	);
	await run(
		"git-base-" + destination.split("/").at(-1),
		["git", "reset", "--mixed", "FETCH_HEAD"],
		destination,
	);
}
const tests = [
	"specialist",
	"specialist-turn",
	"specialist-document",
	"specialist-memory",
	"specialist-lifecycle",
	"specialist-flush",
].map((n) => `api/domains/dialogue/test/${n}.test.ts`);
try {
	await run("core-verify", ["bun", "run", "verify"], root);
	const files = [
		...new Bun.Glob("{src,contexts,.s11tnext}/**/*").scanSync({
			cwd: root,
			onlyFiles: true,
			dot: true,
		}),
		"package.json",
		"bun.lock",
		"s11tnext.config.toml",
		"README.md",
		"LICENSE",
	].sort();
	const fileDigests = Object.fromEntries(
		await Promise.all(
			files.map(async (path) => [
				path,
				digest(new Uint8Array(await Bun.file(join(root, path)).arrayBuffer())),
			]),
		),
	);
	const manifest = {
		packageVersion,
		...sourceProvenance(root),
		sourceTreeDigest: digest(JSON.stringify(fileDigests)),
		files: fileDigests,
		coreContractVersion,
		supportedStateSchemaVersions,
		hostBaselineCommit: declaredBaseline,
		environment: { bun: Bun.version },
		generation: "bun run pack:check",
	};
	await Bun.write(
		join(root, "manifest.json"),
		JSON.stringify(manifest, null, "\t") + "\n",
	);
	await run("manifest-format", ["bun", "fmt", "manifest.json"], root);
	await mkdir(join(root, "dist"), { recursive: true });
	await run(
		"pack",
		["bun", "pm", "pack", "--destination", join(root, "dist")],
		root,
	);
	const tgz = join(root, `dist/eumenes-collaboration-${packageVersion}.tgz`);
	report.tgzSha256 = digest(new Uint8Array(await Bun.file(tgz).arrayBuffer()));
	const content = await run("pack-contents", ["tar", "-tzf", tgz], root);
	const paths = content.trim().split("\n");
	if (
		paths.some(
			(path) =>
				!/^package\/(src\/|contexts\/|\.s11tnext\/|package\.json$|manifest\.json$|LICENSE$|README\.md$)/.test(
					path,
				),
		)
	)
		throw new Error("unexpected_packed_file");
	for (const path of [
		"src/index.ts",
		".s11tnext/catalog.json",
		".s11tnext/catalog.generated.ts",
		"manifest.json",
	])
		if (!paths.includes("package/" + path))
			throw new Error("missing_packed_resource:" + path);
	// Check the actual archive even in package-only mode, where no consumer is installed.
	for (const [path, expected] of Object.entries(fileDigests)) {
		if (path === "bun.lock" || path === "s11tnext.config.toml") continue;
		const packed = Bun.spawnSync(["tar", "-xOf", tgz, "package/" + path], {
			cwd: root,
		});
		if (packed.exitCode !== 0 || digest(packed.stdout) !== expected)
			throw new Error("packed_resource_mismatch:" + path);
	}
	report.sourceProvenance = {
		sourceCommit: manifest.sourceCommit,
		sourceBaseCommit: manifest.sourceBaseCommit,
		sourceTreeDirty: manifest.sourceTreeDirty,
	};
	if (!host.ok) {
		if (process.env.PACK_CHECK_REQUIRE_HOST === "1")
			throw new Error(`host_integration_required:${host.reason}`);
		report.hostIntegration = { status: "skipped", reason: host.reason };
		console.log(
			`host-integration skipped: ${host.reason} (set EUMENES_SOURCE / EUMENES_BASELINE_COMMIT to run it)`,
		);
	} else {
		report.hostIntegration = {
			status: "run",
			baseline: baselineCommit,
			declaredBaseline,
		};
		await archiveTo(baseline);
		await run(
			"baseline-install",
			["bun", "install", "--frozen-lockfile"],
			baseline,
		);
		await run("baseline-specialist", ["bun", "test", ...tests], baseline);
		await archiveTo(candidate);
		await applyHostAdapter(candidate);
		await mkdir(join(candidate, "vendor/collaboration"), { recursive: true });
		await cp(tgz, join(candidate, "vendor/collaboration/package.tgz"));
		const packagePath = join(candidate, "package.json");
		const pkg = await Bun.file(packagePath).json();
		pkg.dependencies["eumenes-collaboration"] =
			"file:vendor/collaboration/package.tgz";
		await Bun.write(packagePath, JSON.stringify(pkg, null, "\t") + "\n");
		await run("candidate-install-lock", ["bun", "install"], candidate);
		report.lockfileSha256 = digest(
			await Bun.file(join(candidate, "bun.lock")).text(),
		);
		await rm(join(candidate, "node_modules"), { recursive: true, force: true });
		await run(
			"candidate-install-frozen",
			["bun", "install", "--frozen-lockfile"],
			candidate,
		);
		await run(
			"candidate-format",
			[
				"bun",
				"fmt",
				"api/domains/dialogue/service/specialist-prompt.ts",
				"api/domains/dialogue/service/specialist-memory.ts",
			],
			candidate,
		);
		await run(
			"candidate-context-build",
			["bun", "run", "context:build"],
			candidate,
		);
		await run("candidate-typecheck", ["bun", "run", "typecheck"], candidate);
		await run(
			"candidate-context-lint",
			["bun", "run", "context:lint"],
			candidate,
		);
		await run(
			"candidate-context-check",
			["bun", "run", "context:check"],
			candidate,
		);
		// Verify the actual resolver chose the installed tarball, not a source alias.
		await Bun.write(
			join(candidate, "collaboration-consumption.ts"),
			`import { collaborationInstructions,coreContractVersion } from "eumenes-collaboration";
	const path=import.meta.resolve("eumenes-collaboration");
	if(!path.includes("/node_modules/eumenes-collaboration/") || coreContractVersion!==1 || !collaborationInstructions.rules) throw new Error("package_resolution_failed");
	console.log(path);
	`,
		);
		report.resolvedEntry = (
			await run(
				"candidate-consumption",
				["bun", "collaboration-consumption.ts"],
				candidate,
			)
		).trim();
		const installedRoot = join(candidate, "node_modules/eumenes-collaboration");
		const installedManifest = await Bun.file(
			join(installedRoot, "manifest.json"),
		).json();
		if (installedManifest.sourceTreeDigest !== manifest.sourceTreeDigest)
			throw new Error("installed_manifest_mismatch");
		for (const [path, expected] of Object.entries(fileDigests)) {
			if (path === "bun.lock" || path === "s11tnext.config.toml") continue;
			const actual = digest(
				new Uint8Array(await Bun.file(join(installedRoot, path)).arrayBuffer()),
			);
			if (actual !== expected)
				throw new Error("installed_resource_mismatch:" + path);
		}
		report.installedSourceTreeDigest = installedManifest.sourceTreeDigest;
		await run(
			"candidate-consumption-format",
			["bun", "fmt", "collaboration-consumption.ts"],
			candidate,
		);
		report.parity = await compareHosts(baseline, candidate);
		await run("candidate-specialist", ["bun", "test", ...tests], candidate);
		await run(
			"candidate-domains",
			[
				"bun",
				"run",
				"verify",
				"--",
				"--domain",
				"dialogue",
				"--domain",
				"inference",
				"--domain",
				"tool-runtime",
				"--domain",
				"capabilities",
				"--domain",
				"ui-compositions",
				"--domain",
				"pipelines",
			],
			candidate,
		);

		await run("candidate-web-build", ["bun", "run", "build:web"], candidate);
		const patch = await run(
			"candidate-patch",
			[
				"git",
				"diff",
				"--binary",
				"HEAD",
				"--",
				"api/domains/dialogue",
				".s11tnext",
				"package.json",
				"bun.lock",
			],
			candidate,
		);
		report.adapterPatchSha256 = digest(patch);
		report.generatedCatalogSha256 = digest(
			await Bun.file(join(candidate, ".s11tnext/catalog.json")).text(),
		);
	}
	await Bun.write(
		join(root, `dist/eumenes-collaboration-${packageVersion}.tgz.sha256`),
		String(report.tgzSha256) +
			`  eumenes-collaboration-${packageVersion}.tgz\n`,
	);
	report.status = host.ok ? "passed" : "passed_package_only";
} catch (error) {
	report.status = "failed";
	report.error = String(error);
	process.exitCode = 1;
} finally {
	await Bun.write(
		join(reportDir, "pack-check.json"),
		JSON.stringify(report, null, 2) + "\n",
	);
	console.log(
		JSON.stringify({
			status: report.status,
			error: report.error,
			report: join(reportDir, "pack-check.json"),
		}),
	);
}
