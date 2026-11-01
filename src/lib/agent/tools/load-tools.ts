/**
 * `load_tools` and `use_tool`, the two tools deferred loading adds to a turn
 * (`deferred.ts`). Neither is offered by the registry's filters:
 * `splitTurnTools` adds them to a turn that defers.
 */

import { registerTool, getDisplayLabel } from '#lib/agent/tools/registry.ts';
import { toolResult, toolError } from '#lib/agent/tools/types.ts';
import {
	LOAD_TOOLS_SCHEMA,
	USE_TOOL,
	USE_TOOL_SCHEMA,
	familyResult
} from '#lib/agent/tools/deferred.ts';

/** Where the user turns a family on, for a family this turn is not offered. */
const TURN_ON: Record<string, string> = {
	documents: 'They need a working folder.',
	email: 'The user can connect an account in Settings → Integrations.',
	calendar: 'The user can connect an account in Settings → Integrations.',
	contacts: 'The user can connect an account in Settings → Integrations.',
	images: 'The user can choose an image model in Settings → Image.',
	music: 'The user can turn it on in Settings → Music.',
	'video-gen': 'The user can turn it on in Settings → Video generation.',
	video: 'They need a working folder and Settings → Video editing.'
};

registerTool({
	category: 'tools-load',
	schema: LOAD_TOOLS_SCHEMA,
	execute: async (args, ctx) => {
		const id = typeof args.family === 'string' ? args.family.trim() : '';
		const family = ctx.deferredTools?.find((f) => f.id === id);
		if (family) return toolResult(familyResult(family));
		const offered = ctx.deferredTools?.map((f) => f.id).join(', ') || 'none';
		const hint = TURN_ON[id] ? ` ${TURN_ON[id]}` : '';
		return toolResult(
			toolError(
				`The ${id || '(no family)'} tools are not available in this conversation.${hint} Families you can load: ${offered}.`
			)
		);
	},
	displayLabel: (args) => `Loading the ${String(args.family ?? '')} tools`
});

// Reached only when the parser could not unwrap the call (`unwrapUseTool`):
// a well-formed call runs the named tool directly.
registerTool({
	category: 'tools-load',
	schema: USE_TOOL_SCHEMA,
	execute: async () =>
		toolResult(
			toolError(
				`${USE_TOOL} needs name, a tool that load_tools gave you, and arguments, an object of its parameters.`
			)
		),
	displayLabel: (args) =>
		typeof args.name === 'string' && args.name !== USE_TOOL
			? getDisplayLabel(args.name, unwrapArgs(args.arguments))
			: 'Calling a loaded tool'
});

function unwrapArgs(raw: unknown): Record<string, unknown> {
	if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
	return {};
}
