import artifact from "../../.s11tnext/catalog.json";
import { createAppCatalog } from "../../.s11tnext/catalog.generated";
const context = createAppCatalog(artifact).bindText({
	instructionLocale: "ja-JP",
	fallbackLocales: [],
	trailingNewline: false,
}).p;
export const collaborationInstructions = Object.freeze({
	state: context("collaboration.state", {}),
	rules: context("collaboration.rules", {}),
	reference: context("collaboration.reference", {}),
	correction: context("collaboration.correction", {}),
});
