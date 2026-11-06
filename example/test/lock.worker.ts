import { Database } from "bun:sqlite";

/** Holds a write lock from another thread so the main thread's busy_timeout can be observed. */
declare const self: Worker;
self.onmessage = (event: MessageEvent<{ path: string; holdMs: number }>) => {
	const db = new Database(event.data.path);
	db.exec("PRAGMA busy_timeout=5000");
	db.exec("BEGIN IMMEDIATE");
	postMessage("locked");
	Atomics.wait(
		new Int32Array(new SharedArrayBuffer(4)),
		0,
		0,
		event.data.holdMs,
	);
	db.exec("COMMIT");
	db.close();
	postMessage("released");
};
