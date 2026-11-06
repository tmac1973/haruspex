/**
 * Schema-aware argument coercion, run once in `executeTool` before any
 * tool executor sees the args.
 *
 * Local models routinely emit arguments that are sloppy but unambiguous:
 * a JSON-encoded string where the schema wants an array, `"5"` for an
 * integer, `"true"` for a boolean, a bare object where an array of one
 * is meant. Rejecting these wastes a whole model round-trip on an error
 * the harness could have absorbed. The `<function=...>` fallback parser
 * already coerces this way (parser.ts); this gives the structured
 * tool_calls path the same forgiveness, driven by each tool's declared
 * JSON schema instead of guesswork.
 *
 * Only clearly-safe conversions happen; anything ambiguous passes
 * through untouched for the tool's own validation to report.
 */

interface ParamSpec {
	type?: string;
	[key: string]: unknown;
}

interface ParamsSchema {
	properties?: Record<string, ParamSpec>;
	[key: string]: unknown;
}

/**
 * The longest balanced `[...]` or `{...}` starting at position 0, or undefined.
 *
 * String-aware, so a bracket inside a label or description does not end the
 * scan early.
 */
function balancedPrefix(s: string): string | undefined {
	const open = s[0];
	if (open !== '[' && open !== '{') return undefined;
	const close = open === '[' ? ']' : '}';
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (escaped) {
			escaped = false;
			continue;
		}
		if (inString) {
			if (c === '\\') escaped = true;
			else if (c === '"') inString = false;
			continue;
		}
		if (c === '"') inString = true;
		else if (c === open) depth++;
		else if (c === close && --depth === 0) return s.slice(0, i + 1);
	}
	return undefined;
}

function tryJson(s: string): unknown {
	if (!s.startsWith('{') && !s.startsWith('[')) return undefined;
	try {
		return JSON.parse(s);
	} catch {
		// Fall through: a model that emitted a valid value and then kept typing
		// is a different failure from one that emitted nonsense, and the first
		// is recoverable. Observed in a real run — an ask_user_question whose
		// options arrived as `[{…},{…},{…}], "recommended": true}]`, a valid
		// array with a stray fragment of the enclosing object after it.
	}
	const prefix = balancedPrefix(s);
	if (prefix === undefined || prefix.length === s.length) return undefined;
	try {
		return JSON.parse(prefix);
	} catch {
		return undefined;
	}
}

function coerceValue(spec: ParamSpec, raw: unknown): unknown {
	switch (spec.type) {
		case 'array': {
			if (Array.isArray(raw)) return raw;
			if (typeof raw === 'string') {
				const parsed = tryJson(raw.trim());
				if (Array.isArray(parsed)) return parsed;
				if (parsed && typeof parsed === 'object') return [parsed];
			}
			// A bare object where an array was meant → singleton list
			if (raw && typeof raw === 'object') return [raw];
			return raw;
		}
		case 'object': {
			if (typeof raw === 'string') {
				const parsed = tryJson(raw.trim());
				if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
			}
			return raw;
		}
		case 'integer':
		case 'number': {
			if (typeof raw === 'string' && /^-?\d+(\.\d+)?$/.test(raw.trim())) {
				const n = Number(raw.trim());
				if (Number.isFinite(n)) return spec.type === 'integer' ? Math.trunc(n) : n;
			}
			return raw;
		}
		case 'boolean': {
			if (raw === 'true') return true;
			if (raw === 'false') return false;
			return raw;
		}
		case 'string': {
			if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
			// An array of strings where one string was meant (code lines,
			// paragraphs) → join. Anything mixed passes through.
			if (Array.isArray(raw) && raw.length > 0 && raw.every((x) => typeof x === 'string')) {
				return raw.join('\n');
			}
			return raw;
		}
		default:
			return raw;
	}
}

/**
 * Return `args` with each property coerced toward the tool's declared
 * parameter schema. Unknown properties and null/undefined values pass
 * through untouched.
 */
export function coerceArgsToSchema(
	params: unknown,
	args: Record<string, unknown>
): Record<string, unknown> {
	const props = (params as ParamsSchema | undefined)?.properties;
	if (!props) return args;
	const out: Record<string, unknown> = { ...args };
	for (const [key, raw] of Object.entries(out)) {
		const spec = props[key];
		if (!spec || raw === null || raw === undefined) continue;
		out[key] = coerceValue(spec, raw);
	}
	return out;
}
