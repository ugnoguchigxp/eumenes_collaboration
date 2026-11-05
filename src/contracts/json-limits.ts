/** Resource contract for JSON crossing a host boundary, independent of its meaning. */
export const JSON_LIMITS = Object.freeze({
	bytes: 2 * 1024 * 1024,
	nodes: 100000,
	depth: 64,
});
export function withinJsonLimits(value: unknown): boolean {
	const stack: Array<{ value: unknown; depth: number; leave?: object }> = [
		{ value, depth: 0 },
	];
	const active = new Set<object>();
	let nodes = 0,
		bytes = 0;
	const size = (text: string) => {
		if (text.length > JSON_LIMITS.bytes) return false;
		bytes += new TextEncoder().encode(text).length;
		return bytes <= JSON_LIMITS.bytes;
	};
	try {
		while (stack.length) {
			const item = stack.pop()!;
			if (item.leave) {
				active.delete(item.leave);
				continue;
			}
			if (++nodes > JSON_LIMITS.nodes || item.depth > JSON_LIMITS.depth)
				return false;
			const v = item.value;
			if (v === null || typeof v === "boolean") {
				bytes += 5;
				continue;
			}
			if (typeof v === "number") {
				if (!Number.isFinite(v)) return false;
				bytes += 24;
				continue;
			}
			if (typeof v === "string") {
				if (!size(v)) return false;
				continue;
			}
			if (typeof v !== "object" || active.has(v)) return false;
			if (
				!Array.isArray(v) &&
				Object.getPrototypeOf(v) !== Object.prototype &&
				Object.getPrototypeOf(v) !== null
			)
				return false;
			active.add(v);
			stack.push({ value: null, depth: 0, leave: v });
			const keys = Object.keys(v);
			if (nodes + keys.length > JSON_LIMITS.nodes) return false;
			bytes += keys.length * 4;
			if (bytes > JSON_LIMITS.bytes) return false;
			for (const key of keys) {
				if (!Array.isArray(v) && !size(key)) return false;
				stack.push({
					value: (v as Record<string, unknown>)[key],
					depth: item.depth + 1,
				});
			}
		}
		return bytes <= JSON_LIMITS.bytes;
	} catch {
		return false;
	}
}
