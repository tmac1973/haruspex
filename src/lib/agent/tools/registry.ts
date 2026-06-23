import type { ToolDefinition } from '$lib/api';
import type { ToolRegistration, ToolExecOutput, ToolContext } from './types';
import { toolResult, toolError } from './types';
import { coerceArgsToSchema } from './coerce';
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
	shellAllowWrite: boolean;
	codeMode: boolean;
	hasEmail: boolean;
	sandboxEnabled: boolean;
}

// Tools exposed to the Shell-tab agent. Reads are always on; writes
// require shellAllowWrite. Email and sandbox don't make sense for
// admin troubleshooting and stay hidden.
const SHELL_FS_READS = new Set(['fs_read_text', 'fs_list_dir', 'fs_read_pdf']);
const SHELL_FS_WRITES = new Set(['fs_write_text', 'fs_edit_text']);

// The lean Code-tab toolset: Pi's core (read/write/edit/bash + ls/grep/find)
// plus web research. Keeping this list small is the single biggest context
// lever (every exposed tool's schema ships in every request — see plan §7).
const CODE_TOOLS = new Set([
	'fs_read_text',
	'fs_list_dir',
	'fs_edit_text',
	'fs_write_text',
	'code_grep',
	'code_glob',
	'run_command',
	'web_search',
	'research_url'
]);

// `fs`-category tools that should only ever appear in Code mode — keeps the
// Chat schema lean (it otherwise exposes every fs tool when a workdir is set).
const CODE_ONLY_FS = new Set(['code_grep', 'code_glob']);

// Interactive PTY-control tools. Only meaningful in Code mode driving a live
// shell session (the Shell tab in Code mode), where there's a real terminal to
// drive — not the standalone Code tab (one-shot exec, no PTY).
const SHELL_INTERACTIVE_TOOLS = new Set(['shell_read', 'shell_input', 'shell_interrupt']);

function shouldIncludeShellTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// `exec` (run_command) is Code-mode only — never expose it in Shell mode,
	// which has its own real terminal.
	if (reg.category === 'exec') return false;
	if (reg.category === 'web') {
		if (opts.deepResearch && name === 'fetch_url') return false;
		return true;
	}
	if (reg.category === 'fs') {
		if (SHELL_FS_READS.has(name)) return true;
		if (opts.shellAllowWrite && SHELL_FS_WRITES.has(name)) return true;
		return false;
	}
	// Email, sandbox, etc. are intentionally hidden in Shell mode.
	return false;
}

function shouldIncludeCodeTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	if (CODE_TOOLS.has(name)) return true;
	// Interactive terminal control only when Code mode drives a live shell
	// session (shellMode), where there's a real PTY to send input/signals to.
	if (SHELL_INTERACTIVE_TOOLS.has(name)) return opts.shellMode;
	return false;
}

function shouldIncludeChatTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	const name = reg.schema.function.name;
	// `exec` (run_command) runs arbitrary host commands — Code mode only.
	// Without this, the `return true` fall-through would leak it into Chat.
	if (reg.category === 'exec') return false;
	// code_grep / code_glob are Code-mode fs tools; keep them out of Chat.
	if (CODE_ONLY_FS.has(name)) return false;
	if (reg.category === 'fs' && !opts.hasWorkingDir) return false;
	if (reg.category === 'email' && !opts.hasEmail) return false;
	if (reg.category === 'sandbox' && !opts.sandboxEnabled) return false;
	if (opts.deepResearch && name === 'fetch_url') return false;
	if (!opts.visionSupported && reg.requiresVision) return false;
	return true;
}

function shouldIncludeTool(reg: ToolRegistration, opts: ToolFilterOpts): boolean {
	// codeMode wins over shellMode: the Shell assistant in Code mode exposes the
	// code toolset (resolved against the live shell CWD), not the plain shell set.
	if (opts.codeMode) return shouldIncludeCodeTool(reg, opts);
	if (opts.shellMode) return shouldIncludeShellTool(reg, opts);
	return shouldIncludeChatTool(reg, opts);
}

export function getToolSchemas(opts: {
	hasWorkingDir: boolean;
	deepResearch?: boolean;
	visionSupported?: boolean;
	shellMode?: boolean;
	shellAllowWrite?: boolean;
	codeMode?: boolean;
}): ToolDefinition[] {
	const filter: ToolFilterOpts = {
		hasWorkingDir: opts.hasWorkingDir,
		deepResearch: opts.deepResearch ?? false,
		visionSupported: opts.visionSupported ?? true,
		shellMode: opts.shellMode ?? false,
		shellAllowWrite: opts.shellAllowWrite ?? false,
		codeMode: opts.codeMode ?? false,
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
		const hint = nearestToolName(name);
		return toolResult(toolError(`Unknown tool: ${name}${hint ? `. Did you mean ${hint}?` : ''}`));
	}

	// Guard: fs/exec tools require a working directory in Chat/Code mode. In
	// Shell mode the absolute-path variants are dispatched instead, so
	// workingDir is allowed to be null.
	if ((reg.category === 'fs' || reg.category === 'exec') && !ctx.workingDir && !ctx.shellMode) {
		return toolResult(toolError('No working directory set'));
	}

	// Absorb sloppy-but-unambiguous arg shapes (stringified JSON, "5" for
	// an integer, ...) before the executor's own validation runs — see
	// coerce.ts. Saves a whole model round-trip per avoided error.
	return reg.execute(coerceArgsToSchema(reg.schema.function.parameters, args), ctx);
}

/**
 * Closest registered tool name for a hallucinated one, so the model can
 * recover in one step instead of dead-ending on "Unknown tool".
 */
function nearestToolName(name: string): string | null {
	let best: string | null = null;
	let bestDist = 4; // suggest only within edit distance 3
	for (const candidate of tools.keys()) {
		const d = editDistance(name, candidate);
		if (d < bestDist) {
			bestDist = d;
			best = candidate;
		}
	}
	// Fallback: a distinctive substring match ("write_file" → fs_write_text
	// is too far for edit distance, but "pdf" → fs_write_pdf isn't needed;
	// keep it simple and only do edit distance plus suffix containment).
	if (!best) {
		const lower = name.toLowerCase();
		for (const candidate of tools.keys()) {
			if (candidate.toLowerCase().includes(lower) || lower.includes(candidate.toLowerCase())) {
				return candidate;
			}
		}
	}
	return best;
}

function editDistance(a: string, b: string): number {
	if (Math.abs(a.length - b.length) > 3) return 99;
	const prev = new Array(b.length + 1).fill(0).map((_, i) => i);
	for (let i = 1; i <= a.length; i++) {
		let diag = prev[0];
		prev[0] = i;
		for (let j = 1; j <= b.length; j++) {
			const tmp = prev[j];
			prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
			diag = tmp;
		}
	}
	return prev[b.length];
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
