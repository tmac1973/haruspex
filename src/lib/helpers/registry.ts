/**
 * Helpers: tools the Code tab's agent runs with no model behind them, such
 * as building and rendering a 3D model to check it. Each helper owns some
 * tools and has a switch in Settings → Code → Helpers, off by default; the
 * tool filter offers a helper's tools only while its switch is on.
 *
 * Imports only the settings store, so the tool registry and the Code tab
 * profile can read it without an import cycle.
 */
import type { Component } from 'svelte';
import { getSettings } from '#lib/stores/settings.ts';

/** A helper's own settings, stored as plain JSON under its id (`codeHelperConfig`). */
export interface HelperSettings<T> {
	/** Cleans whatever is stored (absent, old or hand-edited) into a valid T. */
	parse(raw: unknown): T;
	/** The editor shown under the switch while the helper is on. */
	component: () => Promise<{ default: Component<{ helperId: string }> }>;
}

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
	/** Its own settings, if it has any. A lazy component, so this file pulls in no Svelte. */
	settings?: HelperSettings<unknown>;
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

/** Helper `id`'s settings, parsed; `undefined` when it has none. */
export function helperConfig<T>(id: string): T | undefined {
	const def = registered.get(id);
	if (!def?.settings) return undefined;
	return def.settings.parse(getSettings().codeHelperConfig?.[id]) as T;
}

/** For tests: forget every helper. */
export function _resetHelpersForTests(): void {
	registered.clear();
	byTool.clear();
}
