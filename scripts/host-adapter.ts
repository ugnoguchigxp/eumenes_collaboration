import { join } from "node:path";

/** Apply only to an isolated archive of the recorded Eumenes commit. */
export async function applyHostAdapter(root: string) {
	const service = join(root, "api/domains/dialogue/service");
	await Bun.write(
		join(service, "specialist-prompt.ts"),
		`import { createCollaborationContract, collaborationInstructions } from "eumenes-collaboration";
import { systemContext } from "../../../infrastructure/system-context";
import { agentControl, rejectedOutputMessage, type ControlContract } from "../../inference";
import type { SpecialistSet } from "../contracts";
import { isBriefSpokenReply, SPOKEN_REPLY_MAX_CHARS, SPOKEN_REPLY_MAX_SENTENCES, spokenReplyMeasure } from "../../delivery";
export type { SpecialistAction } from "eumenes-collaboration";
const contract = createCollaborationContract({
 maxChars: SPOKEN_REPLY_MAX_CHARS,
 maxSentences: SPOKEN_REPLY_MAX_SENTENCES,
 validate: isBriefSpokenReply,
 measure: spokenReplyMeasure,
 description: "短い返答。replyでは必須。invokeでは操作が成功したときの返答（任意）。音声で聞かれるため通常一文、補足込みでも二文・300字以内。制作物や実装内容は読み上げない。",
});
export const parseSpecialistAction = contract.parse;
export const specialistViolations = contract.violations;
export const violationNames = contract.violationNames;
const RULES = collaborationInstructions.rules + "\\n" + systemContext("dialogue.contexts.specialist-turn.rules", {});
export function specialistControl(set: SpecialistSet, hostTools: ReadonlyArray<{id:string; description:string; inputSchema:unknown}> = []): ControlContract {
 return agentControl({profile:set.profile,skills:set.skills,rules:RULES,tools:[...set.tools.map(tool => ({id:tool.id, description:tool.summary, inputSchema:tool.schema})),...hostTools],outputSchema:contract.outputSchema});
}
export const correctionMessage = (raw:string, violations:ReturnType<typeof specialistViolations>, callsLeft:number) => rejectedOutputMessage(collaborationInstructions.correction, raw, violations, callsLeft);
`,
	);
	const memoryPath = join(service, "specialist-memory.ts");
	let memory = await Bun.file(memoryPath).text();
	const functionStart = memory.indexOf(
		"export function specialistTurnMessages",
	);
	if (functionStart < 0) throw new Error("host_memory_contract_changed");
	const signature = memory.slice(
		functionStart,
		memory.indexOf("): ChatMessage[] {", functionStart),
	);
	memory =
		memory.slice(0, memory.lastIndexOf("/**", functionStart)) +
		signature +
		`): ChatMessage[] {
 return buildCollaborationMessages({...input,time:promptTime(input.nowMs)});
}
`;
	memory = memory.replace(
		'import { systemContext } from "../../../infrastructure/system-context";',
		'import { buildCollaborationMessages } from "eumenes-collaboration";',
	);
	const referenceStart = memory.indexOf("const REFERENCE =");
	const referenceEnd = memory.indexOf("type Outcome =", referenceStart);
	if (referenceStart < 0 || referenceEnd < 0)
		throw new Error("host_reference_contract_changed");
	memory = memory.slice(0, referenceStart) + memory.slice(referenceEnd);
	await Bun.write(memoryPath, memory);
	const context = join(root, "api/domains/dialogue/contexts/specialist-turn");
	await Bun.write(
		join(context, "rules.context.toml"),
		`# Host-specific delivery and save policy; common rules come from the package.
text = '''
- 音声で聞かれるため、短く話します。
- 保存は画面の保存ボタンで行い、保存したとは言いません。
'''
`,
	);
	// Their only consumers now use the package's generated catalog.
	await Bun.file(join(context, "reference.context.toml")).delete();
	await Bun.file(join(context, "correction.context.toml")).delete();
}
