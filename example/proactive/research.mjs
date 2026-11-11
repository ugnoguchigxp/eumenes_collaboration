import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** An independent Codex search turn; only the public query is sent to it. */
export async function createResearchService(host, complete) {
	const { codexSearchMessages, parseCodexSearchHits } = await import(
		pathToFileURL(
			resolve(host, "api/domains/web-research/adapters/codex-search.ts"),
		).href
	);
	return async ({ query }, signal) => {
		const { messages, outputSchema } = codexSearchMessages({ query, limit: 4 });
		const result = await complete("research", {
			messages,
			outputSchema,
			signal,
		});
		const sources = parseCodexSearchHits(JSON.stringify(result.output), 4);
		if (!sources.length) throw new Error("research_no_public_sources");
		return {
			sources: sources.map(({ url, title, snippet }) => ({
				url,
				title,
				snippet,
			})),
		};
	};
}
