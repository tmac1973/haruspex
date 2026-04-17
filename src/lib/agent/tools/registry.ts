import type { ToolDefinition } from '$lib/api';
import type { ToolRegistration, ToolExecOutput, ToolContext } from './types';
import { toolResult, toolError } from './types';
import { hasEnabledEmailAccount } from '$lib/stores/settings';

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
export function getToolSchemas(opts: {
	hasWorkingDir: boolean;
	deepResearch?: boolean;
	visionSupported?: boolean;
}): ToolDefinition[] {
	const { hasWorkingDir, deepResearch = false, visionSupported = true } = opts;
	const hasEmail = hasEnabledEmailAccount();
	const schemas: ToolDefinition[] = [];

	for (const reg of tools.values()) {
		const name = reg.schema.function.name;

		if (reg.category === 'fs' && !hasWorkingDir) continue;
		if (reg.category === 'email' && !hasEmail) continue;
		if (deepResearch && name === 'fetch_url') continue;
		if (!visionSupported && reg.requiresVision) continue;

		schemas.push(reg.schema);
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

	// Guard: fs tools require a working directory
	if (reg.category === 'fs' && !ctx.workingDir) {
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
