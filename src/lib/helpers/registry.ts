/**
 * Helpers: tools the Code tab's agent runs with no model behind them, such
 * as building and rendering a 3D model to check it. Each helper owns some
 * tools and has a switch in Settings → Code → Helpers, off by default, and a
 * Code session can turn each on or off for itself (`sessionHelpers`); the
 * tool filter offers a helper's tools only while the session has it on.
 *
 * Imports only the settings store, so the tool registry and the Code tab
 * profile can read it without an import cycle.
 */
import { getSettings } from '#lib/stores/settings.ts';

export interface HelperDef {
	id: string;
	/** The card row's name. */
	label: string;
	/** One short sentence under the name. */
	summary: string;
	/** The row's `title` tooltip: what it does in more detail. */
	tooltip: string;
	/** The tools it owns, by name. */
	tools: string[];
	/** Its tools write into the project (the writer lease; refused when read-only). */
	writes: boolean;
}

const registered = new Map<string, HelperDef>();
const byTool = new Map<string, HelperDef>();

export function registerHelper(def: HelperDef): void {
	if (registered.has(def.id)) throw new Error(`Helper '${def.id}' is already registered.`);
	for (const tool of def.tools) {
		const owner = byTool.get(tool);
		if (owner) throw new Error(`Tool '${tool}' already belongs to helper '${owner.id}'.`);
	}
	registered.set(def.id, def);
	for (const tool of def.tools) byTool.set(tool, def);
}

/** Every registered helper, in registration order. */
export function helpers(): HelperDef[] {
	return [...registered.values()];
}

/** The helper that owns `tool`, if any. */
export function helperForTool(tool: string): HelperDef | undefined {
	return byTool.get(tool);
}

/** Whether the user has switched `id` on. */
export function helperOn(id: string): boolean {
	return getSettings().codeHelpers?.[id] === true;
}

/**
 * The helpers a Code session offers, in registration order: the ids it
 * stored, or with none stored, the ones switched on in Settings. An id no
 * helper has any more is ignored.
 */
export function sessionHelpers(stored: string[] | null | undefined): HelperDef[] {
	if (stored === null || stored === undefined) return helpers().filter((h) => helperOn(h.id));
	const on = new Set(stored);
	return helpers().filter((h) => on.has(h.id));
}

/** For tests: forget every helper. */
export function _resetHelpersForTests(): void {
	registered.clear();
	byTool.clear();
}
