import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiBudget } from "../adapters/api-budget.ts";
import { ExampleStateStore } from "../state-store.ts";
import { host, initial, proposal } from "../../test/state.fixture.ts";

/** Another thread takes the write lock (BEGIN IMMEDIATE) and commits after `holdMs`. */
async function hold(path: string, holdMs: number) {
	const worker = new Worker(new URL("./lock.worker.ts", import.meta.url));
	const waitFor = (message: string) =>
		new Promise<void>((resolve) => {
			const listen = (event: MessageEvent) => {
				if (event.data === message) {
					worker.removeEventListener("message", listen);
					resolve();
				}
			};
			worker.addEventListener("message", listen);
		});
	const locked = waitFor("locked"),
		released = waitFor("released");
	worker.postMessage({ path, holdMs });
	await locked;
	return {
		released,
		async done() {
			await released;
			worker.terminate();
		},
	};
}
const withDirectory = async (body: (path: string) => Promise<void>) => {
	const dir = await mkdtemp(join(tmpdir(), "collaboration-busy-"));
	try {
		await body(join(dir, "db.sqlite"));
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
};

test("the budget waits for a lock held briefly by another connection", () =>
	withDirectory(async (path) => {
		const budget = new ApiBudget(path, 1, 3000);
		try {
			const lock = await hold(path, 100);
			const started = performance.now();
			const id = budget.reserve("openai", 0.2);
			expect(performance.now() - started).toBeGreaterThanOrEqual(50);
			budget.settle(id, 0.1, {});
			expect(budget.used()).toBe(0.1);
			await lock.done();
		} finally {
			budget.close();
		}
	}));

test("the budget fails explicitly with api_budget_busy and records nothing when the lock outlasts the timeout", () =>
	withDirectory(async (path) => {
		const budget = new ApiBudget(path, 1, 30);
		try {
			const lock = await hold(path, 400);
			expect(() => budget.reserve("openai", 0.2)).toThrow("api_budget_busy");
			await lock.done();
			expect(budget.used()).toBe(0);
			expect(budget.db.query("SELECT * FROM api_calls").all()).toEqual([]);
			expect(budget.reserve("openai", 0.2)).toBeString();
		} finally {
			budget.close();
		}
	}));

test("a budget with an invalid busy timeout is refused", () => {
	expect(() => new ApiBudget(":memory:", 1, -1)).toThrow("api_budget_invalid");
	expect(() => new ApiBudget(":memory:", 1, 1.5)).toThrow("api_budget_invalid");
});

test("state adoption waits for a short lock and then commits exactly once", () =>
	withDirectory(async (path) => {
		const store = new ExampleStateStore(path, 3000);
		try {
			store.initialize(initial(), 2);
			const lock = await hold(path, 100);
			const result = store.adopt("s", "op", proposal(), host());
			expect(result.ok).toBe(true);
			await lock.done();
			expect(store.db.query("SELECT id FROM example_receipts").all()).toEqual([
				{ id: "op" },
			]);
		} finally {
			store.close();
		}
	}));

test("state adoption fails with state_store_busy and leaves no receipt when the lock outlasts the timeout", () =>
	withDirectory(async (path) => {
		const store = new ExampleStateStore(path, 30);
		try {
			store.initialize(initial(), 2);
			const lock = await hold(path, 400);
			expect(() => store.adopt("s", "op", proposal(), host())).toThrow(
				"state_store_busy",
			);
			await lock.done();
			expect(store.read("s")).toEqual(initial());
			expect(store.db.query("SELECT * FROM example_receipts").all()).toEqual(
				[],
			);
		} finally {
			store.close();
		}
	}));

test("an invalid busy timeout is refused before the store opens", () => {
	expect(() => new ExampleStateStore(":memory:", -1)).toThrow(
		"busy_timeout_invalid",
	);
});
