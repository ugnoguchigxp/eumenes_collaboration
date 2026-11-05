import { withinJsonLimits } from "eumenes-collaboration";
import { z } from "zod";
import type { ModelAdapter } from "./model.ts";
import { ApiBudget } from "./api-budget.ts";
type Schema = Record<string, unknown>;
const obj = (v: unknown): Schema =>
	v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Schema) : {};
/** JSON Schema free-form JSON is transported as JSON text, then decoded before host validation. */
export function apiSchema(schema: Schema): {
	schema: Schema;
	decode: (value: unknown) => unknown;
} {
	const transform = (s: Schema): Schema => {
		if (
			s.$ref ||
			(s.type === "object" &&
				s.properties === undefined &&
				s.additionalProperties !== false)
		)
			return {
				type: "string",
				description:
					"JSON-encoded value. Return valid JSON text, including quotes for a string.",
			};
		const out: Schema = { ...s };
		delete out.$schema;
		delete out.$defs;
		// Claude's constrained decoder rejects these keywords; the original host Zod schema still enforces them.
		for (const key of [
			"minimum",
			"maximum",
			"minLength",
			"maxLength",
			"minItems",
			"maxItems",
		]) {
			if (out[key] !== undefined)
				out.description =
					String(out.description ?? "") + ` ${key}: ${out[key]}.`;
			delete out[key];
		}
		for (const key of ["anyOf", "allOf", "oneOf"])
			if (Array.isArray(s[key]))
				out[key] = (s[key] as unknown[]).map((x) => transform(obj(x)));
		if (out.const !== undefined) {
			out.enum = [out.const];
			delete out.const;
		}
		if (s.type === "object") {
			const props = obj(s.properties),
				required = new Set(Array.isArray(s.required) ? s.required : []);
			out.properties = Object.fromEntries(
				Object.entries(props).map(([k, v]) => [
					k,
					required.has(k)
						? transform(obj(v))
						: { anyOf: [transform(obj(v)), { type: "null" }] },
				]),
			);
			out.required = Object.keys(props);
			out.additionalProperties = false;
		}
		if (s.type === "array") out.items = transform(obj(s.items));
		return out;
	};
	const decode = (s: Schema, v: unknown): unknown => {
		if (
			s.$ref ||
			(s.type === "object" &&
				s.properties === undefined &&
				s.additionalProperties !== false)
		) {
			if (typeof v !== "string") throw new Error("api_json_value_invalid");
			return JSON.parse(v);
		}
		if (s.type === "array") {
			if (!Array.isArray(v)) return v;
			return v.map((x) => decode(obj(s.items), x));
		}
		if (s.type === "object") {
			const value = obj(v),
				required = new Set(Array.isArray(s.required) ? s.required : []);
			return Object.fromEntries(
				Object.entries(value)
					.filter(([k, x]) => x !== null || required.has(k))
					.map(([k, x]) => [k, decode(obj(obj(s.properties)[k]), x)]),
			);
		}
		return v;
	};
	return { schema: transform(schema), decode: (v) => decode(schema, v) };
}
const usageSchema = z.object({
	input_tokens: z.number().int().nonnegative(),
	output_tokens: z.number().int().nonnegative(),
	cache_creation_input_tokens: z.number().int().nonnegative().optional(),
	cache_read_input_tokens: z.number().int().nonnegative().optional(),
});
export type ApiConfig = {
	provider: "anthropic" | "openai";
	model: string;
	budget: ApiBudget;
	maxOutputTokens: number;
	timeoutMs: number;
	apiKey?: string;
	fetcher?: (url: string, init: RequestInit) => Promise<Response>;
};
/** Direct HTTP adapters perform inference only, with no retries, tools or provider fallback. */
export function createApiModel(config: ApiConfig): ModelAdapter {
	const key =
		config.apiKey ??
		process.env[
			config.provider === "anthropic" ? "ANTHROPIC_API_KEY" : "OPENAI_API_KEY"
		];
	if (
		!key ||
		config.model !==
			(config.provider === "anthropic" ? "claude-haiku-5-5" : "gpt-6-luna") ||
		!Number.isSafeInteger(config.maxOutputTokens) ||
		config.maxOutputTokens < 1 ||
		config.maxOutputTokens > 4096 ||
		!Number.isFinite(config.timeoutMs) ||
		config.timeoutMs <= 0
	)
		throw new Error("api_configuration_required");
	return {
		async infer(request) {
			request.signal.throwIfAborted();
			if (
				request.messages[0]?.role !== "system" ||
				request.messages.slice(1).some((m) => m.role === "system")
			)
				throw new Error("model_instruction_boundary_invalid");
			if (
				!withinJsonLimits(request.messages) ||
				!withinJsonLimits(request.outputSchema)
			)
				throw new Error("api_input_capacity_exceeded");
			const wire = apiSchema(request.outputSchema),
				system = request.messages[0].content;
			const messages = request.messages.slice(1);
			const body =
				config.provider === "anthropic"
					? {
							model: config.model,
							system,
							messages,
							max_tokens: config.maxOutputTokens,
							output_config: {
								format: { type: "json_schema", schema: wire.schema },
							},
						}
					: {
							model: config.model,
							instructions: system,
							input: messages,
							max_output_tokens: config.maxOutputTokens,
							store: false,
							tools: [],
							text: {
								format: {
									type: "json_schema",
									name: "collaboration",
									strict: true,
									schema: wire.schema,
								},
							},
						};
			const serialized = JSON.stringify(body),
				bytes = new TextEncoder().encode(serialized).length;
			if (bytes > 64000) throw new Error("api_input_capacity_exceeded");
			// Conservative bound: one token per UTF-8 byte + 4096 protocol tokens, at $2/$10 per MTok.
			// Actual selected short-context models cost $0.10/$0.50; no cache discount is assumed.
			const reserve =
				((bytes + 4096) * 2) / 1e6 + (config.maxOutputTokens * 10) / 1e6 + 0.01;
			const id = config.budget.reserve(config.provider, reserve),
				started = performance.now();
			const headers: Record<string, string> = {
				"content-type": "application/json",
			};
			if (config.provider === "anthropic") {
				headers["x-api-key"] = key;
				headers["anthropic-version"] = "2023-06-01";
			} else headers.authorization = `Bearer ${key}`;
			const response = await (config.fetcher ?? fetch)(
				config.provider === "anthropic"
					? "https://api.anthropic.com/v1/messages"
					: "https://api.openai.com/v1/responses",
				{
					method: "POST",
					headers,
					body: serialized,
					signal: AbortSignal.any([
						request.signal,
						AbortSignal.timeout(config.timeoutMs),
					]),
				},
			);
			if (!response.ok) throw new Error(`api_http_${response.status}`);
			const reader = response.body?.getReader();
			if (!reader) throw new Error("api_body_missing");
			let size = 0;
			const chunks: Uint8Array[] = [];
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					size += value.length;
					if (size > 2 * 1024 * 1024)
						throw new Error("api_output_capacity_exceeded");
					chunks.push(value);
				}
			} finally {
				await reader.cancel();
			}
			const joined = new Uint8Array(size);
			let offset = 0;
			for (const chunk of chunks) {
				joined.set(chunk, offset);
				offset += chunk.length;
			}
			const data = obj(JSON.parse(new TextDecoder().decode(joined)));
			const usage = usageSchema.parse(data.usage);
			const input =
				usage.input_tokens +
				(usage.cache_creation_input_tokens ?? 0) +
				(usage.cache_read_input_tokens ?? 0);
			const cost = (input * 0.5 + usage.output_tokens * 2.5) / 1e6;
			const metadata = {
				requestId:
					response.headers.get("request-id") ??
					response.headers.get("x-request-id"),
				model: data.model,
				usage,
				ms: performance.now() - started,
				priceDate: "2026-11-05",
				costKind: "conservative_estimate",
				baseEstimateUsd: (input * 0.1 + usage.output_tokens * 0.5) / 1e6,
			};
			config.budget.settle(id, cost, metadata);
			let text = "";
			if (config.provider === "anthropic") {
				if (data.stop_reason !== "end_turn")
					throw new Error("api_result_incomplete");
				for (const c of Array.isArray(data.content) ? data.content : [])
					if (obj(c).type === "text") text += String(obj(c).text ?? "");
			} else {
				if (data.status !== "completed")
					throw new Error("api_result_incomplete");
				for (const item of Array.isArray(data.output) ? data.output : [])
					for (const c of Array.isArray(obj(item).content)
						? (obj(item).content as unknown[])
						: [])
						if (obj(c).type === "output_text")
							text += String(obj(c).text ?? "");
			}
			request.signal.throwIfAborted();
			if (!text) throw new Error("api_result_missing_or_refused");
			return { output: wire.decode(JSON.parse(text)), costUsd: cost };
		},
	};
}
