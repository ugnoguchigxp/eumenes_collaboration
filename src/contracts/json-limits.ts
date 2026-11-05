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
	// Count JSON's encoded bytes without allocating an escaped copy of a large string.
	const size = (text: string) => {
		if (text.length > JSON_LIMITS.bytes) return false;
		bytes += 2; // quotes
		for (let i = 0; i < text.length; i++) {
			const code = text.charCodeAt(i);
			if (code === 34 || code === 92) bytes += 2;
			else if (code < 32) bytes += [8, 9, 10, 12, 13].includes(code) ? 2 : 6;
			else if (code < 128) bytes++;
			else if (code < 2048) bytes += 2;
			else if (code >= 0xd800 && code <= 0xdbff) {
				const next = text.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					bytes += 4;
					i++;
				} else bytes += 6; // JSON escapes an unpaired surrogate.
			} else bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
			if (bytes > JSON_LIMITS.bytes) return false;
		}
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
				bytes += v === false ? 5 : 4;
				continue;
			}
			if (typeof v === "number") {
				if (!Number.isFinite(v)) return false;
				bytes += String(v).length;
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
			const array = Array.isArray(v);
			if (
				array &&
				(keys.length !== v.length || keys.some((key, i) => key !== String(i)))
			)
				return false;
			bytes += 2 + Math.max(0, keys.length - 1) + (array ? 0 : keys.length);
			if (bytes > JSON_LIMITS.bytes) return false;
			for (const key of keys) {
				if (!array && !size(key)) return false;
				const descriptor = Object.getOwnPropertyDescriptor(v, key);
				if (!descriptor || !Object.hasOwn(descriptor, "value")) return false;
				stack.push({
					value: descriptor.value,
					depth: item.depth + 1,
				});
			}
		}
		return bytes <= JSON_LIMITS.bytes;
	} catch {
		return false;
	}
}
