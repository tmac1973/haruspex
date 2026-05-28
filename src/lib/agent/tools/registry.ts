import type { ToolDefinition } from '$lib/api';
import type { ToolRegistration, ToolExecOutput, ToolContext } from './types';
import { toolResult, toolError } from './types';
import { hasEnabledEmailAccount, getSettings } from '$lib/stores/settings';

const tools = new Map<string, ToolRegistration>();

export function registerTool(reg: ToolRegistration): void {
	tools.set(reg.schema.function.name, reg);
}

/**
 * Get the tool schemas to expose to the model for this request.
 *
 * Filtering logic:
 * - Filesystem tools only included when a working directory is active
 * - In deep-research mode, fetch_url is removed so the model uses research_url
 * - Vision-dependent tools filtered when backend doesn't support vision
 * - Email tools hidden until the user has enabled at least one account
 */
interface ToolFilterOpts {
	hasWorkingDir: boolean;
	deepResearch: boolean;
	visionSupported: boolean;
	shellMode: boolean;
	hasEmail: boolean;
	sandboxEnabled: boolean;
}

function shouldIncludeTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// fs tools are workdir-gated in Chat mode but available system-wide
	// (no workdir required) in Shell mode.
	if (reg.category === 'fs' && !opts.hasWorkingDir && !opts.shellMode) return false;
	if (reg.category === 'email' && !opts.hasEmail) return false;
	if (reg.category === 'sandbox' && !opts.sandboxEnabled) return false;
	if (opts.deepResearch && name === 'fetch_url') return false;
	if (!opts.visionSupported && reg.requiresVision) return false;
	return true;
}

export function getToolSchemas(opts: {
	hasWorkingDir: boolean;
	deepResearch?: boolean;
	visionSupported?: boolean;
	shellMode?: boolean;
}): ToolDefinition[] {
	const filter: ToolFilterOpts = {
		hasWorkingDir: opts.hasWorkingDir,
		deepResearch: opts.deepResearch ?? false,
		visionSupported: opts.visionSupported ?? true,
		shellMode: opts.shellMode ?? false,
		hasEmail: hasEnabledEmailAccount(),
		sandboxEnabled: getSettings().sandboxEnabled
	};
	const schemas: ToolDefinition[] = [];
	for (const reg of tools.values()) {
		if (shouldIncludeTool(reg, filter)) schemas.push(reg.schema);
	}
	return schemas;
}

/**
 * Execute a tool by name. Replaces the 30-arm switch statement.
 */
export async function executeTool(
	name: string,
	args: Record<string, unknown>,
	ctx: ToolContext
): Promise<ToolExecOutput> {
	const reg = tools.get(name);
	if (!reg) {
		return toolResult(toolError(`Unknown tool: ${name}`));
	}

	// Guard: fs tools require a working directory in Chat mode. In
	// Shell mode the absolute-path variants are dispatched instead, so
	// workingDir is allowed to be null.
	if (reg.category === 'fs' && !ctx.workingDir && !ctx.shellMode) {
		return toolResult(toolError('No working directory set'));
	}

	return reg.execute(args, ctx);
}

/**
 * Extract a human-readable label from tool arguments for the search
 * step UI. Replaces the onToolStart switch in chat.svelte.ts.
 */
export function getDisplayLabel(name: string, args: Record<string, unknown>): string {
	const reg = tools.get(name);
	if (!reg) return JSON.stringify(args).slice(0, 60);
	return reg.displayLabel(args);
}
