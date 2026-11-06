import { expect, test } from "bun:test";
import { selectTargets } from "../scripts/clean-work.ts";

const names = [
	"clean-abc1234-x1y2",
	"push-check-3qoekta8",
	"quality-pack-o0e_gd6n",
	"review-package-b407ecd",
	"evaluation-baseline",
	"evaluation-baseline-2",
	"eumenes-baseline",
	"eumenes-candidate",
	"host.tar",
	"diagnose-api.ts",
	"notes.md",
];

test("by default only the known temporary patterns are selected", () => {
	expect(selectTargets(names)).toEqual([
		"clean-abc1234-x1y2",
		"push-check-3qoekta8",
		"quality-pack-o0e_gd6n",
		"review-package-b407ecd",
	]);
	expect(selectTargets(names, { all: false })).toEqual(selectTargets(names));
});

test("evaluation-baseline, eumenes-* and host.tar are protected without --all", () => {
	const selected = selectTargets(names);
	for (const name of [
		"evaluation-baseline",
		"evaluation-baseline-2",
		"eumenes-baseline",
		"eumenes-candidate",
		"host.tar",
	])
		expect(selected).not.toContain(name);
});

test("--all adds the protected entries but still leaves unknown files", () => {
	const selected = selectTargets(names, { all: true });
	expect(selected).toEqual([
		"clean-abc1234-x1y2",
		"push-check-3qoekta8",
		"quality-pack-o0e_gd6n",
		"review-package-b407ecd",
		"evaluation-baseline",
		"evaluation-baseline-2",
		"eumenes-baseline",
		"eumenes-candidate",
		"host.tar",
	]);
	expect(selected).not.toContain("diagnose-api.ts");
	expect(selected).not.toContain("notes.md");
});

test("the work directory itself and path-like names are never selected", () => {
	const odd = ["", ".", "..", ".work", "clean-/x", "../clean-a", "clean-a\\b"];
	expect(selectTargets(odd, { all: true })).toEqual([]);
});

test("a name must start with the pattern, not merely contain it", () => {
	expect(selectTargets(["my-clean-x", "old-push-check-1"])).toEqual([]);
});
