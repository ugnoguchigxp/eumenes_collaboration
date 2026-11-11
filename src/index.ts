export * from "./contracts/index.ts";
export {
	CollaborationError,
	STATE_REJECT_REASONS,
	DECISION_REJECT_REASONS,
	HOST_INPUT_ERROR_CODES,
	type StateRejectReason,
	type DecisionRejectReason,
	type HostInputErrorCode,
	type Issue,
	type Rejected,
} from "./contracts/errors.ts";
export { turnContextSchema } from "./contracts/turn.ts";
export { createCollaborationContract } from "./agent/action.ts";
export { createStatefulCollaborationContract } from "./agent/stateful-turn.ts";
export { buildCollaborationMessages } from "./agent/messages.ts";
export { collaborationInstructions } from "./agent/instructions.ts";
export const coreContractVersion = 1 as const;
export const supportedStateSchemaVersions: readonly number[] = [1];
export * from "./contracts/state.ts";
export {
	checkStateApproval,
	stateApprovalSchema,
	APPROVAL_REJECT_REASONS,
	type StateApproval,
	type ApprovalHostContext,
	type ApprovalRejectReason,
} from "./agent/approval.ts";
export {
	proposeStateUpdate,
	forgetStateSources,
	type StateRejection,
} from "./agent/state.ts";
export {
	checkSessionDecision,
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
	checkPlan,
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
	checkBrowserChoice,
	type BrowserChoice,
} from "./agent/plan.ts";
/** 2 since 0.3.0: the decision helpers return a result under new names instead of throwing. */
export const decisionContractVersion = 2 as const;

export { withinJsonLimits, JSON_LIMITS } from "./contracts/json-limits.ts";
