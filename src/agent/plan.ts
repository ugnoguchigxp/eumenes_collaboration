import { z } from "zod";
import {
	collaborationFactSchema,
	type CollaborationFact,
} from "../contracts/state.ts";

export const MAX_PLAN_STEPS = 5;
export const STEP_INFERENCE_BUDGET = 10;
export const PLAN_INFERENCE_CAP = 30;
const ref = z.string().min(1).max(256);
// Both plan.<id> and result.<id> must fit the 256-character fact-id contract.
const stepRef = z.string().min(1).max(249);
export const planStepSchema = z.strictObject({
	id: stepRef,
	goal: z.string().min(1).max(16000),
	inputs: z.array(stepRef).max(MAX_PLAN_STEPS),
	output: z.enum(["findings", "screen", "summary"]),
	browser: z.boolean(),
	keepOpen: z.boolean(),
	rationale: z.string().min(1).max(2000),
});
export const planProposalSchema = z.strictObject({
	steps: z.array(planStepSchema).min(1).max(MAX_PLAN_STEPS),
});
export type PlanStep = z.infer<typeof planStepSchema>;
export type Plan = { steps: PlanStep[]; facts: CollaborationFact[] };

/** The model chooses meaning and tools. Code checks only the proposal's structure and dependencies. */
export function planSteps(proposal: unknown, sourceRef: string): Plan {
	ref.parse(sourceRef);
	const { steps } = planProposalSchema.parse(proposal);
	const prior = new Set<string>();
	for (const step of steps) {
		if (
			prior.has(step.id) ||
			new Set(step.inputs).size !== step.inputs.length ||
			step.inputs.some((id) => !prior.has(id))
		)
			throw new Error("plan_dependency_invalid");
		if (step.keepOpen && !step.browser)
			throw new Error("plan_browser_required");
		prior.add(step.id);
	}
	return {
		steps,
		facts: steps.map((s) => ({
			id: `plan.${s.id}`,
			kind: "assumption",
			status: "proposed",
			value: { ...s, provenance: "inferred" },
			sourceRefs: [sourceRef],
			supersedes: [],
		})),
	};
}

export const browserChoiceSchema = z.strictObject({
	browser: z.boolean(),
	rationale: z.string().min(1).max(2000),
	answer: z.string().max(16000),
});
export type BrowserChoice = z.infer<typeof browserChoiceSchema>;
export function parseBrowserChoice(value: unknown): BrowserChoice {
	return browserChoiceSchema.parse(value);
}

/** A step result longer than this is cut, so one step cannot flood the next step's context. */
export const STEP_RESULT_CHARS = 1000;

/** A step's result as a fact: confirmed by what the host observed, never by the model's word alone. */
export function stepResultFact(
	stepId: string,
	result: string,
	observationRefs: readonly string[],
): CollaborationFact {
	stepRef.parse(stepId);
	if (observationRefs.length === 0)
		throw new Error("step_result_without_observation");
	return collaborationFactSchema.parse({
		id: `result.${stepId}`,
		kind: "condition",
		status: "confirmed",
		value: {
			provenance: "observed",
			text:
				result.length > STEP_RESULT_CHARS
					? `${result.slice(0, STEP_RESULT_CHARS)}…`
					: result,
		},
		sourceRefs: [...observationRefs],
		supersedes: [],
	});
}

export type PlanBudget = { perStep: number; overall: number };

/** 10 inferences a step, at most 30 for the whole request. */
export function planBudget(stepCount: number): PlanBudget {
	if (
		!Number.isSafeInteger(stepCount) ||
		stepCount < 1 ||
		stepCount > MAX_PLAN_STEPS
	)
		throw new Error("plan_step_count_invalid");
	return {
		perStep: STEP_INFERENCE_BUDGET,
		overall: Math.min(
			Math.max(stepCount, 1) * STEP_INFERENCE_BUDGET,
			PLAN_INFERENCE_CAP,
		),
	};
}

/**
 * Whether the next step may start: `ask` when what is left is less than one step's budget — the host then
 * returns what it has and asks the user whether to go on — and `stop` when nothing is left.
 */
export function budgetCheck(
	used: number,
	budget: PlanBudget,
): { decision: "go" | "ask" | "stop"; remaining: number } {
	// A count the host cannot trust (NaN, negative, infinite) stops rather than going on.
	if (
		!Number.isSafeInteger(used) ||
		used < 0 ||
		!Number.isSafeInteger(budget.overall) ||
		!Number.isSafeInteger(budget.perStep) ||
		budget.overall < 1 ||
		budget.perStep < 1
	)
		return { decision: "stop", remaining: 0 };
	const remaining = Math.max(budget.overall - used, 0);
	if (remaining === 0) return { decision: "stop", remaining };
	if (remaining < budget.perStep) return { decision: "ask", remaining };
	return { decision: "go", remaining };
}
