export * from "./contracts/index.ts";
export { createCollaborationContract } from "./agent/action.ts";
export { buildCollaborationMessages } from "./agent/messages.ts";
export { collaborationInstructions } from "./agent/instructions.ts";
export const coreContractVersion = 1 as const;
export const supportedStateSchemaVersions: readonly number[] = [1];
export * from "./contracts/state.ts";
export { proposeStateUpdate, forgetStateSources } from "./agent/state.ts";
export {
	decideSession,
	sessionDecisionSchema,
	type SessionDecision,
} from "./agent/session.ts";
export {
	completeBrief,
	briefSlots,
	type Brief,
	type BriefInput,
	type BriefSlot,
} from "./agent/brief.ts";
export {
	planSteps,
	planStepSchema,
	planProposalSchema,
	browserChoiceSchema,
	STEP_RESULT_CHARS,
	stepResultFact,
	planBudget,
	budgetCheck,
	MAX_PLAN_STEPS,
	STEP_INFERENCE_BUDGET,
	PLAN_INFERENCE_CAP,
	type Plan,
	type PlanStep,
	type PlanBudget,
	parseBrowserChoice,
	type BrowserChoice,
} from "./agent/plan.ts";
export const decisionContractVersion = 1 as const;

export { withinJsonLimits, JSON_LIMITS } from "./contracts/json-limits.ts";
