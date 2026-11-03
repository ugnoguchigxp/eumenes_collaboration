import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFixtureWorkflow } from "./scenario.ts";

const directory = await mkdtemp(join(tmpdir(), "collaboration-example-"));
try {
	console.log(
		JSON.stringify(
			await runFixtureWorkflow(join(directory, "state.sqlite")),
			null,
			2,
		),
	);
} finally {
	await rm(directory, { recursive: true, force: true });
}
