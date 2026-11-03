import { z } from "zod";
import tasks from "./tasks.json";
const task = z.strictObject({
	id: z.string(),
	group: z.enum(["structured", "ui", "pipeline", "external"]),
	split: z.enum(["development", "holdout"]),
	turns: z.array(z.string()).min(5),
	expected: z.record(z.string(), z.json()),
	unresolved: z.array(z.string()),
	forbiddenOperations: z.array(z.string()),
	evidenceRequired: z.array(z.string()),
	status: z.literal("not_run"),
});
const checked = z.array(task).parse(tasks);
if (new Set(checked.map((task) => task.id)).size !== 32)
	throw new Error("task_inventory_invalid");
for (const group of ["structured", "ui", "pipeline", "external"])
	for (const split of ["development", "holdout"])
		if (
			checked.filter((task) => task.group === group && task.split === split)
				.length !== 4
		)
			throw new Error("task_split_invalid");
console.log(
	JSON.stringify({
		tasks: checked.length,
		status: "inventory_checked",
		semanticEvaluation: "not_run",
		costUsd: null,
	}),
);
