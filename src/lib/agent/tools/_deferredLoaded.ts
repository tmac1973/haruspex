/**
 * What a loaded tool family looks like in the messages (`deferred.ts`). Apart
 * from it so the loop can read it without pulling in the registry.
 */

import type { ChatMessage, ToolDefinition } from '#lib/api.ts';
import { messageText } from '#lib/api.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';

const OPEN = '<tools_loaded family="';

/** The first line of a `load_tools` result. */
export function loadedMarker(id: string): string {
	return `${OPEN}${id}">`;
}

/**
 * The families loaded in `messages`: a marker in what the model is sent.
 * When a turn is dropped, trimmed or summarised away, its schemas go with it,
 * and so does the family, so the next call gets them again.
 */
export function loadedFamilies(messages: ChatMessage[]): Set<string> {
	const ids = new Set<string>();
	for (const m of messages) {
		if (m.role !== 'tool') continue;
		const text = messageText(m.content);
		if (!text.startsWith(OPEN)) continue;
		const end = text.indexOf('"', OPEN.length);
		if (end > OPEN.length) ids.add(text.slice(OPEN.length, end));
	}
	return ids;
}

/** What `load_tools` returns for a family: the marker, its notes, then its schemas. */
export function familyResult(family: DeferredFamily): string {
	const fns = family.schemas.map((s) => s.function);
	return [
		loadedMarker(family.id),
		...(family.notes ? [family.notes.trim()] : []),
		'Call these tools through use_tool, with name and arguments:',
		JSON.stringify(fns)
	].join('\n');
}

/**
 * The system prompt's list of families. It does not change while a
 * conversation runs: a loaded family stays listed, and the `load_tools`
 * result at the tail says it is loaded.
 */
export function toolIndexSection(deferred: DeferredFamily[] | undefined): string {
	if (!deferred?.length) return '';
	const lines = deferred.map((f) => `- ${f.line}`).join('\n');
	return `\n\nMORE TOOLS (call load_tools with the family first, then use_tool):\n${lines}`;
}

/** The deferred family a tool belongs to, when this turn defers it. */
export function deferredFamilyOf(
	name: string,
	deferred: DeferredFamily[] | undefined
): DeferredFamily | undefined {
	return deferred?.find((f) => f.schemas.some((s) => s.function.name === name));
}

/**
 * The deferred tool a call means: its own name, or the same name with `-` for
 * `_` (`video-probe` for `video_probe`), which small models write. Undefined
 * when neither is a tool this turn defers.
 */
export function deferredToolName(
	name: string,
	deferred: DeferredFamily[] | undefined
): string | undefined {
	if (deferredFamilyOf(name, deferred)) return name;
	const underscored = name.replace(/-/g, '_');
	return underscored !== name && deferredFamilyOf(underscored, deferred) ? underscored : undefined;
}

interface ParamSpec {
	type?: string | string[];
	enum?: unknown[];
}

const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
	string: (v) => typeof v === 'string',
	number: (v) => typeof v === 'number' && Number.isFinite(v),
	integer: (v) => Number.isInteger(v),
	boolean: (v) => typeof v === 'boolean',
	array: Array.isArray,
	object: (v) => typeof v === 'object' && v !== null && !Array.isArray(v),
	null: (v) => v === null
};

/**
 * Whether `args` fit the tool's schema well enough to run a call the model
 * made before it loaded the tool: every required parameter present, no
 * parameter the schema doesn't name, and each value of its declared type and
 * enum. Nested objects are not checked; the tool checks those itself.
 */
export function argumentsFit(
	schema: ToolDefinition | undefined,
	args: Record<string, unknown>
): boolean {
	const params = schema?.function.parameters as
		{ properties?: Record<string, ParamSpec>; required?: unknown } | undefined;
	const props = params?.properties ?? {};
	const required = Array.isArray(params?.required) ? params.required : [];
	for (const key of required) {
		if (typeof key === 'string' && (args[key] === undefined || args[key] === null)) return false;
	}
	return Object.entries(args).every(([key, value]) => valueFits(props[key], value));
}

/** A value against its parameter's type and enum; false for a parameter the schema lacks. */
function valueFits(spec: ParamSpec | undefined, value: unknown): boolean {
	if (!spec) return false;
	if (value === undefined) return true;
	const types = spec.type === undefined ? [] : [spec.type].flat();
	if (types.length && !types.some((t) => TYPE_CHECKS[t]?.(value) ?? true)) return false;
	return !Array.isArray(spec.enum) || spec.enum.includes(value);
}
