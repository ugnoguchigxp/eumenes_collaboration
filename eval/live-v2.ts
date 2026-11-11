import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import { ApiBudget } from "../example/adapters/api-budget.ts";
import { createApiModel } from "../example/adapters/api-model.ts";
import type { ModelAdapter } from "../example/adapters/model.ts";
import { proposeDecisions } from "../example/decision-turn.ts";
import { ExampleStateStore } from "../example/state-store.ts";
import { proposeFacts } from "../example/state-turn.ts";
import type {
	CollaborationState,
	StateHostContext,
	TurnContext,
} from "../src/index.ts";
import decisions from "./decisions.json";
import { createDryRunModel } from "./dry-run-model.ts";
import {
	buildJudgeInput,
	JUDGE_SYSTEM,
	judgeSchema,
	loadTasks,
	type TaskV2,
	type StateCheckpoint,
} from "./tasks-v2.ts";

export type Provider = "anthropic" | "openai";
export type Arm = "baseline" | "candidate";
export const PROVIDERS: readonly Provider[] = ["anthropic", "openai"];
export const MODEL_IDS: Record<Provider, string> = {
	anthropic: "claude-haiku-5-5",
	openai: "gpt-6-luna",
};
const root = resolve(import.meta.dir, "..");
export const REPORTS_DIR = join(root, "reports/quality-2026-11-06");
const FATAL_REASONS = [
	"api_budget_exhausted",
	"api_http_400",
	"api_http_401",
	"api_http_403",
	"api_http_404",
	// Released without cost, but retrying at once only repeats the refusal: stop and rerun later.
	"api_http_429",
	"api_json_value_invalid",
];

export type Options = {
	runName: string;
	tasksPath: string;
	protocolPath: string;
	split: "development" | "holdout" | "all";
	providers: Provider[];
	arms: Arm[];
	reps: number;
	baselineReps: number;
	baselineDir: string;
	budgetDb: string;
	cap: number;
	stopAt: number;
	groups: string[] | null;
	limit: number | null;
	decisions: boolean;
	dryRun: boolean;
};

const list = <T extends string>(
	value: string,
	allowed: readonly T[],
	name: string,
) => {
	const items = value.split(",").map((s) => s.trim());
	if (
		items.length === 0 ||
		items.some((i) => !allowed.includes(i as T)) ||
		new Set(items).size !== items.length
	)
		throw new Error(`${name}_invalid`);
	return items as T[];
};
const positiveInt = (value: string, name: string) => {
	if (!/^[0-9]+$/.test(value) || Number(value) < 1)
		throw new Error(`${name}_invalid`);
	return Number(value);
};

/** v2 is historical; new comparative runs must match the registered repetitions before any model call. */
export function validateEvaluationPlan(
	options: Options,
	protocol: Record<string, any>,
	tasksHash: string,
) {
	if ((protocol.version ?? 0) < 3) return;
	if (protocol.status !== "registered")
		throw new Error("evaluation_protocol_not_registered");
	if (
		options.arms.includes("baseline") &&
		options.arms.includes("candidate") &&
		options.reps !== options.baselineReps
	)
		throw new Error("evaluation_repetitions_asymmetric");
	if (
		options.reps !== protocol.repetitions?.candidate ||
		options.baselineReps !== protocol.repetitions?.baseline
	)
		throw new Error("evaluation_repetitions_changed");
	if (options.split === "holdout" && protocol.holdout?.sha256 !== tasksHash)
		throw new Error("evaluation_holdout_changed");
}

export function parseCliArgs(argv: readonly string[]): Options {
	const { values, positionals } = parseArgs({
		args: [...argv],
		allowPositionals: true,
		strict: true,
		options: {
			tasks: { type: "string" },
			protocol: { type: "string" },
			split: { type: "string" },
			providers: { type: "string" },
			arms: { type: "string" },
			reps: { type: "string" },
			"baseline-reps": { type: "string" },
			"baseline-dir": { type: "string" },
			"budget-db": { type: "string" },
			cap: { type: "string" },
			"stop-at": { type: "string" },
			groups: { type: "string" },
			limit: { type: "string" },
			decisions: { type: "boolean" },
			"dry-run": { type: "boolean" },
		},
	});
	const runName = positionals[0];
	if (positionals.length !== 1 || !runName || !/^[a-zA-Z0-9_-]+$/.test(runName))
		throw new Error("run_name_invalid");
	if (!values.tasks) throw new Error("tasks_required");
	if (!values.protocol) throw new Error("protocol_required");
	const split = values.split ?? "development";
	if (!["development", "holdout", "all"].includes(split))
		throw new Error("split_invalid");
	const cap = values.cap === undefined ? 10 : Number(values.cap);
	const stopAt =
		values["stop-at"] === undefined ? 9 : Number(values["stop-at"]);
	if (!Number.isFinite(cap) || cap <= 0 || cap > 10)
		throw new Error("cap_invalid");
	if (!Number.isFinite(stopAt) || stopAt <= 0 || stopAt > cap)
		throw new Error("stop_at_invalid");
	return {
		runName,
		tasksPath: resolve(values.tasks),
		protocolPath: resolve(values.protocol),
		split: split as Options["split"],
		providers: values.providers
			? list(values.providers, PROVIDERS, "providers")
			: [...PROVIDERS],
		arms: values.arms
			? list(values.arms, ["baseline", "candidate"] as const, "arms")
			: ["baseline", "candidate"],
		reps: values.reps ? positiveInt(values.reps, "reps") : 3,
		baselineReps: values["baseline-reps"]
			? positiveInt(values["baseline-reps"], "baseline_reps")
			: values.reps
				? positiveInt(values.reps, "reps")
				: 3,
		baselineDir: resolve(
			values["baseline-dir"] ?? join(root, ".work/evaluation-baseline-v2"),
		),
		budgetDb: resolve(
			values["budget-db"] ?? join(REPORTS_DIR, "api-budget.sqlite"),
		),
		cap,
		stopAt,
		groups: values.groups
			? values.groups.split(",").map((s) => s.trim())
			: null,
		limit: values.limit ? positiveInt(values.limit, "limit") : null,
		decisions: values.decisions === true,
		dryRun: values["dry-run"] === true,
	};
}

export function selectTasks(
	tasks: readonly TaskV2[],
	options: Pick<Options, "split" | "groups" | "limit">,
): TaskV2[] {
	const groups = options.groups;
	if (groups && groups.some((g) => !tasks.some((t) => t.group === g)))
		throw new Error("groups_invalid");
	const selected = tasks.filter(
		(t) =>
			(options.split === "all" || t.split === options.split) &&
			(!groups || groups.includes(t.group)),
	);
	return options.limit ? selected.slice(0, options.limit) : selected;
}

/**
 * Serialized, append-only run log. A failed append is remembered in `failure` and never swallowed, and later
 * records still queue; callers stop calling the API once `failure` is set.
 */
export function createLog(
	path: string,
	appender: (path: string, data: string) => Promise<void> = appendFile,
) {
	let write: Promise<void> = Promise.resolve();
	let failure: unknown = null;
	return {
		record(value: unknown) {
			write = write
				.then(() => appender(path, JSON.stringify(value) + "\n"))
				.catch((e) => {
					failure ??= e;
				});
			return write;
		},
		flush: () => write,
		get failure() {
			return failure;
		},
	};
}

export type ArmImpl = {
	proposeFacts: typeof proposeFacts;
	Store: typeof ExampleStateStore;
	packageVersion: string;
};
const packageVersionOf = async (dir: string) => {
	const parsed = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
	return typeof parsed.version === "string" ? parsed.version : "unknown";
};
async function loadArms(
	baselineDir: string,
	arms: readonly Arm[],
): Promise<Partial<Record<Arm, ArmImpl>>> {
	const loaded: Partial<Record<Arm, ArmImpl>> = {};
	if (arms.includes("candidate"))
		loaded.candidate = {
			proposeFacts,
			Store: ExampleStateStore,
			packageVersion: await packageVersionOf(root),
		};
	if (arms.includes("baseline")) {
		const turn = join(baselineDir, "example/state-turn.ts"),
			store = join(baselineDir, "example/state-store.ts");
		for (const file of [turn, store, join(baselineDir, "package.json")])
			if (!(await Bun.file(file).exists()))
				throw new Error("evaluation_baseline_missing");
		loaded.baseline = {
			proposeFacts: (
				(await import(turn)) as { proposeFacts: typeof proposeFacts }
			).proposeFacts,
			Store: (
				(await import(store)) as { ExampleStateStore: typeof ExampleStateStore }
			).ExampleStateStore,
			packageVersion: await packageVersionOf(baselineDir),
		};
	}
	return loaded;
}

export type Deps = {
	appender?: (path: string, data: string) => Promise<void>;
	createModel?: (provider: Provider, budget: ApiBudget) => ModelAdapter;
	loadArms?: typeof loadArms;
	reportsDir?: string;
	concurrency?: number;
	print?: (line: string) => void;
};

const sha256 = (data: string | Uint8Array) =>
	createHash("sha256").update(data).digest("hex");
const git = (...args: string[]) => {
	const result = Bun.spawnSync(["git", ...args], { cwd: root });
	if (result.exitCode !== 0) throw new Error("git_failed");
	return result.stdout;
};

/** Digest of the working-tree files that make up the library under test (the tree is not committed per run). */
export async function workingTreeDigests() {
	const out: Record<string, { files: number; sha256: string }> = {};
	for (const dir of ["src", "contexts", ".s11tnext", "example"]) {
		const names = git("ls-files", "-co", "--exclude-standard", "-z", "--", dir)
			.toString()
			.split("\0")
			.filter(Boolean)
			.sort();
		const lines: string[] = [];
		for (const name of names) {
			const file = Bun.file(join(root, name));
			if (!(await file.exists())) continue;
			lines.push(
				`${name}\0${sha256(new Uint8Array(await file.arrayBuffer()))}`,
			);
		}
		out[dir] = { files: lines.length, sha256: sha256(lines.join("\n")) };
	}
	return out;
}

type Verdicts = Record<Provider, unknown>;

export async function run(
	options: Options,
	deps: Deps = {},
): Promise<{ exitCode: number; runDir: string }> {
	const print = deps.print ?? ((line: string) => console.log(line));
	const runDir = join(deps.reportsDir ?? REPORTS_DIR, options.runName);
	const protocolFile = join(runDir, "live-protocol.json");
	const logFile = join(runDir, "live.jsonl");

	// ---- Preflight. Nothing below the protocol write has happened yet; any failure here leaves no protocol,
	// so the same run name can be started again.
	if (
		(await Bun.file(protocolFile).exists()) ||
		(await Bun.file(logFile).exists())
	)
		throw new Error(
			"live_run_already_started_use_new_protocol_not_silent_replay",
		);
	const { tasks: allTasks, sha256: tasksSha256 } = await loadTasks(
		options.tasksPath,
	);
	const tasks = selectTasks(allTasks, options);
	if (tasks.length === 0) throw new Error("no_tasks_selected");
	const protocolBytes = new Uint8Array(await readFile(options.protocolPath));
	const registered = JSON.parse(new TextDecoder().decode(protocolBytes));
	validateEvaluationPlan(options, registered, tasksSha256);
	const arms = await (deps.loadArms ?? loadArms)(
		options.baselineDir,
		options.arms,
	);
	let tempDir: string | null = null;
	let budgetDb = options.budgetDb;
	if (options.dryRun) {
		tempDir = await mkdtemp(join(tmpdir(), "live-v2-dry-"));
		budgetDb = join(tempDir, "api-budget.sqlite");
	} else await mkdir(dirname(budgetDb), { recursive: true });
	const budget = new ApiBudget(budgetDb, options.cap);
	let exitCode = 0;
	try {
		const models = {} as Record<Provider, ModelAdapter>;
		for (const provider of PROVIDERS)
			models[provider] = deps.createModel
				? deps.createModel(provider, budget)
				: options.dryRun
					? createDryRunModel()
					: createApiModel({
							provider,
							model: MODEL_IDS[provider],
							budget,
							maxOutputTokens: 2048,
							timeoutMs: 60000,
						});
		const treeDigests = await workingTreeDigests();
		const status = git("status", "--porcelain");
		const protocol = {
			evaluationVersion: registered.version ?? 2,
			runName: options.runName,
			dryRun: options.dryRun,
			tasksPath: options.tasksPath,
			tasksSha256,
			selection: {
				split: options.split,
				groups: options.groups,
				limit: options.limit,
				taskIds: tasks.map((t) => t.id),
			},
			preregistration: {
				path: options.protocolPath,
				sha256: sha256(protocolBytes),
			},
			git: {
				head: git("rev-parse", "HEAD").toString().trim(),
				statusPorcelainSha256: sha256(status),
				dirty: status.length > 0,
			},
			workingTree: treeDigests,
			models: MODEL_IDS,
			providers: options.providers,
			arms: options.arms,
			reps: { candidate: options.reps, baseline: options.baselineReps },
			baselineDir: options.baselineDir,
			armPackageVersions: {
				candidate: arms.candidate?.packageVersion ?? null,
				baseline: arms.baseline?.packageVersion ?? null,
			},
			budget: {
				capUsd: options.cap,
				stopAtUsd: options.stopAt,
				db: options.dryRun ? "temporary (dry run)" : budgetDb,
			},
			concurrency: deps.concurrency ?? 2,
			maxOutputTokens: 2048,
			timeoutMs: 60000,
			maxRepairCallsPerTurn: 1,
			decisions: options.decisions,
			grading:
				"every session is graded by both providers; the grader sees conversation, material, expected, unresolved and facts only",
		};
		await mkdir(runDir, { recursive: true });
		await Bun.write(protocolFile, JSON.stringify(protocol, null, 2) + "\n");

		// ---- Run.
		const log = createLog(logFile, deps.appender);
		let stopped = false;
		let workerFailure: unknown = null;
		const shouldStop = () => {
			if (!stopped && budget.used() >= options.stopAt) stopped = true;
			return stopped || log.failure !== null || workerFailure !== null;
		};
		const turnContext = (
			utterance: string,
			material?: NonNullable<TaskV2["material"]>,
		): Omit<TurnContext, "system"> => ({
			utterance,
			course: { course: [], interrupted: null, handedOver: null },
			work: {
				label: "検証用の条件整理",
				dirty: false,
				current: material?.carrier === "work" ? { report: material.text } : {},
				savedRef: null,
			},
			viewing: null,
			time: { now: "2026-11-06T00:00:00+09:00", timeZone: "Asia/Tokyo" },
			callsLeft: 2,
			...(material?.carrier === "document"
				? {
						document: {
							path: "material.md",
							revision: 1,
							title: "資料",
							outlined: false,
							body: material.text,
							rejected: null,
							inlineBytes: 4096,
						},
					}
				: {}),
		});

		async function runSession(
			provider: Provider,
			arm: Arm,
			task: TaskV2,
			rep: number,
		) {
			const impl = arms[arm]!;
			const model = models[provider];
			const store = new impl.Store(":memory:");
			// Neutral id: the state, and therefore the grader's input, must not name the provider or the arm.
			const id = task.id;
			const state: CollaborationState = {
				stateSchemaVersion: 1,
				coreContractVersion: 1,
				packageVersion: impl.packageVersion,
				sessionId: id,
				revision: 0,
				sourceRevision: 0,
				work: { ref: "fixture-work", revision: 0, digest: "fixture" },
				facts: [],
			};
			store.initialize(state, 1);
			const sources: Array<{ ref: string; text: string }> = [];
			const checkpoints: StateCheckpoint[] = [];
			let accepted = 0;
			let errors = 0;
			let incomplete = false;
			const started = performance.now();
			try {
				for (const [i, utterance] of task.turns.entries()) {
					if (shouldStop()) {
						incomplete = true;
						break;
					}
					sources.push({ ref: `u${i + 1}`, text: utterance });
					const material =
						task.material && i >= task.material.atTurn
							? task.material
							: undefined;
					const sourceText = material
						? [...sources, { ref: "m1", text: material.text }]
						: sources;
					const host: StateHostContext = {
						sessionId: id,
						epoch: 1,
						sourceRevision: i + 1,
						work: state.work,
						sources: sourceText.map((s) => ({
							ref: s.ref,
							active: true,
							kind:
								s.ref === "m1" ? ("observation" as const) : ("user" as const),
						})),
					};
					try {
						const propose = (context: Omit<TurnContext, "system">) =>
							impl.proposeFacts(
								model,
								context,
								store.read(id),
								host,
								sourceText,
								new AbortController().signal,
							);
						let checked = await propose(turnContext(utterance, material));
						const attemptCosts = [checked.costUsd];
						if (!checked.ok && !shouldStop()) {
							const repair = turnContext(utterance, material);
							repair.callsLeft = 1;
							repair.course.course = [
								{ utterance, outcome: "failed", error: checked.reason },
							];
							checked = await propose(repair);
							attemptCosts.push(checked.costUsd);
						}
						if (checked.ok) {
							const result = store.adopt(
								id,
								`${id}-r${rep}-${i}`,
								checked.proposal,
								host,
							);
							if (result.ok) accepted++;
							else errors++;
						} else errors++;
						await log.record({
							kind: "turn",
							provider,
							arm,
							task: task.id,
							rep,
							turn: i,
							ok: checked.ok,
							...(!checked.ok ? { reason: checked.reason } : {}),
							costUsd: attemptCosts.some((cost) => cost === null)
								? null
								: attemptCosts.reduce<number>(
										(total, cost) => total + (cost ?? 0),
										0,
									),
							attempts: attemptCosts.length,
						});
					} catch (e) {
						errors++;
						const reason = e instanceof Error ? e.message : "unknown";
						if (FATAL_REASONS.includes(reason)) stopped = true;
						await log.record({
							kind: "turn",
							provider,
							arm,
							task: task.id,
							rep,
							turn: i,
							error: reason,
						});
					}
					checkpoints.push({ turn: i + 1, state: store.read(id) });
				}
				const final = store.read(id) as CollaborationState;
				const verdicts: Verdicts = { anthropic: null, openai: null };
				if (!incomplete)
					for (const judgeProvider of PROVIDERS) {
						if (shouldStop()) {
							incomplete = true;
							break;
						}
						try {
							const result = await models[judgeProvider].infer({
								messages: [
									{ role: "system", content: JUDGE_SYSTEM },
									{
										role: "user",
										content: JSON.stringify(
											buildJudgeInput(task, final, checkpoints),
										),
									},
								],
								outputSchema: z.toJSONSchema(judgeSchema),
								signal: new AbortController().signal,
							});
							const verdict = judgeSchema.parse(result.output);
							verdicts[judgeProvider] = task.material
								? verdict
								: { ...verdict, injectionResisted: null };
						} catch (e) {
							const reason = e instanceof Error ? e.message : "unknown";
							if (FATAL_REASONS.includes(reason)) stopped = true;
							verdicts[judgeProvider] = { error: reason };
						}
					}
				await log.record({
					kind: "session",
					provider,
					arm,
					task: task.id,
					rep,
					split: task.split,
					group: task.group,
					turns: task.turns.length,
					hasMaterial: task.material !== undefined,
					accepted,
					errors,
					ms: performance.now() - started,
					incomplete,
					final,
					checkpoints,
					verdicts,
				});
				print(
					JSON.stringify({
						event: "session",
						provider,
						arm,
						task: task.id,
						rep,
						accepted,
						errors,
						incomplete,
						accountedUsd: budget.used(),
					}),
				);
			} finally {
				store.close();
			}
		}

		// Fixed paired order; development and holdout answers never enter model inputs.
		const jobs = tasks.flatMap((task) =>
			options.providers.flatMap((provider) =>
				options.arms.flatMap((arm) =>
					Array.from(
						{
							length: arm === "candidate" ? options.reps : options.baselineReps,
						},
						(_, rep) => () => runSession(provider, arm, task, rep),
					),
				),
			),
		);
		let next = 0;
		// Every worker is awaited before the budget DB closes, even when one of them fails.
		const settled = await Promise.allSettled(
			Array.from({ length: deps.concurrency ?? 2 }, async () => {
				while (next < jobs.length && !shouldStop()) {
					const job = jobs[next++]!;
					try {
						await job();
					} catch (e) {
						workerFailure ??= e;
						throw e;
					}
				}
			}),
		);
		if (options.decisions && !shouldStop())
			for (const provider of options.providers)
				for (const fixture of decisions) {
					if (shouldStop()) break;
					try {
						const result = await proposeDecisions(
							models[provider],
							turnContext(fixture.utterance),
							fixture.closed,
							"u1",
							new AbortController().signal,
						);
						const wanted = fixture.browser as boolean | null | "optional";
						const correct =
							result.ok &&
							result.session.decision === fixture.expected &&
							(wanted === null ||
								wanted === "optional" ||
								result.plan?.steps[0]?.browser === wanted);
						await log.record({
							kind: "decision",
							provider,
							fixture,
							result,
							correct,
						});
					} catch (e) {
						const reason = e instanceof Error ? e.message : "unknown";
						if (FATAL_REASONS.includes(reason)) stopped = true;
						await log.record({
							kind: "decision",
							provider,
							fixture,
							error: reason,
							correct: false,
						});
					}
				}
		await log.flush();
		await Bun.write(
			join(runDir, "api-budget-summary.json"),
			JSON.stringify(budget.summary(), null, 2) + "\n",
		);
		print(
			JSON.stringify({ event: "complete", stopped, budget: budget.summary() }),
		);
		const failures: Array<[string, unknown]> = [
			["log_write_failed", log.failure],
			// A stopped run is incomplete evidence: never let it look like a finished one.
			...(stopped || next < jobs.length
				? ([
						[
							"run_stopped_before_all_sessions",
							`${Math.min(next, jobs.length)}/${jobs.length} sessions started`,
						],
					] as Array<[string, unknown]>)
				: []),
			...settled.flatMap((s): Array<[string, unknown]> =>
				s.status === "rejected" ? [["worker_failed", s.reason]] : [],
			),
		];
		for (const [label, failure] of failures)
			if (failure !== null) {
				console.error(
					label,
					failure instanceof Error ? failure.message : String(failure),
				);
				exitCode = 1;
			}
	} finally {
		budget.close();
	}
	return { exitCode, runDir };
}

if (import.meta.main) {
	try {
		const { exitCode } = await run(parseCliArgs(process.argv.slice(2)));
		process.exitCode = exitCode;
	} catch (e) {
		console.error(e instanceof Error ? e.message : String(e));
		process.exitCode = 1;
	}
}
