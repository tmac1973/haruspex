/**
 * Deferred tool loading (plan/deferred-tools, phase 03).
 *
 * A turn sends its core tools in full, plus `load_tools` and `use_tool`. The
 * other families it is offered are loaded on request: `load_tools` returns a
 * family's schemas as text, and the model calls them through `use_tool`.
 * `tools` stays the same whatever is loaded, because on llama-server the tool
 * grammar refuses a name that is not listed, and the hybrid Qwen models
 * process the whole prompt again when anything before its tail changes.
 */

import type { ToolDefinition } from '#lib/api.ts';
import type { DeferredFamily } from '#lib/agent/tools/types.ts';
import { allFamilies, isCore } from '#lib/agent/tools/families.ts';
import { toolCategory } from '#lib/agent/tools/registry.ts';
import { familyNotes } from '#lib/agent/tools/familyNotes.ts';
import { parseParamsB } from '#lib/agent/mcpBudget.ts';
import type { DeferTools } from '#lib/stores/settings.ts';

export {
	deferredFamilyOf,
	familyResult,
	loadedFamilies,
	loadedMarker,
	toolIndexSection
} from '#lib/agent/tools/_deferredLoaded.ts';

export const LOAD_TOOLS = 'load_tools';
export const USE_TOOL = 'use_tool';

/** Models above this size defer under `auto`; a size the id does not give, too. */
const AUTO_MIN_PARAMS_B = 12;

export const LOAD_TOOLS_SCHEMA: ToolDefinition = {
	type: 'function',
	function: {
		name: LOAD_TOOLS,
		description:
			'Load a family of tools listed under MORE TOOLS. The result gives their parameters; call them through use_tool.',
		parameters: {
			type: 'object',
			properties: { family: { type: 'string', description: 'The family to load.' } },
			required: ['family']
		}
	}
};

export const USE_TOOL_SCHEMA: ToolDefinition = {
	type: 'function',
	function: {
		name: USE_TOOL,
		description: 'Call a tool that load_tools loaded, by name, with its arguments.',
		parameters: {
			type: 'object',
			properties: {
				name: { type: 'string', description: 'The loaded tool to call.' },
				arguments: { type: 'object', description: "The tool's arguments, as its schema says." }
			},
			required: ['name', 'arguments']
		}
	}
};

/** Who is asking: the turn's kind and the model. */
export interface DeferTurn {
	setting: DeferTools;
	modelId: string | null | undefined;
	interactive: boolean;
	codeMode: boolean;
	shellMode: boolean;
	subtask: boolean;
	/** A tool allowlist (jobs, guests) or a forced final tool. */
	allowlisted: boolean;
	lean: boolean;
}

/**
 * Whether this turn defers. Interactive Chat and the Code tab only: Shell,
 * jobs and guests (an allowlist), subtasks and lean turns keep their sets.
 */
export function deferOn(t: DeferTurn): boolean {
	if (!t.interactive || t.shellMode || t.subtask || t.allowlisted) return false;
	if (!t.codeMode && t.lean) return false;
	if (t.setting === 'off') return false;
	if (t.setting === 'on') return true;
	const params = parseParamsB(t.modelId);
	return params === null || params > AUTO_MIN_PARAMS_B;
}

export interface ToolSplit {
	/** What the request carries: the same on every turn of a conversation. */
	sent: ToolDefinition[];
	/** The families of this turn with at least one offered tool. */
	deferred: DeferredFamily[];
}

/**
 * Divide this turn's offered tools into the core, sent in registry order with
 * `load_tools` and `use_tool` after them, and the families. A turn with no
 * family to defer sends what it was offered.
 */
export function splitTurnTools(
	offered: ToolDefinition[],
	codeTab: boolean,
	readOnly = false
): ToolSplit {
	const families = allFamilies();
	const sent: ToolDefinition[] = [];
	const byId = new Map<string, DeferredFamily>();
	for (const schema of offered) {
		const name = schema.function.name;
		const family = isCore(name, codeTab)
			? undefined
			: families.find((f) => f.has(name, categoryOf(name)));
		if (!family) {
			sent.push(schema);
			continue;
		}
		const entry = byId.get(family.id) ?? {
			id: family.id,
			line: family.line,
			schemas: [],
			notes: familyNotes(family.id, codeTab, readOnly)
		};
		entry.schemas.push(schema);
		byId.set(family.id, entry);
	}
	const deferred = [...byId.values()];
	if (deferred.length === 0) return { sent: offered, deferred };
	sent.push(withFamilyEnum(deferred), USE_TOOL_SCHEMA);
	return { sent, deferred };
}

function categoryOf(name: string): string {
	return toolCategory(name) ?? '';
}

function withFamilyEnum(deferred: DeferredFamily[]): ToolDefinition {
	const fn = LOAD_TOOLS_SCHEMA.function;
	return {
		...LOAD_TOOLS_SCHEMA,
		function: {
			...fn,
			parameters: {
				type: 'object',
				properties: {
					family: {
						type: 'string',
						description: 'The family to load.',
						enum: deferred.map((f) => f.id)
					}
				},
				required: ['family']
			}
		}
	};
}
