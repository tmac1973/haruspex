/**
 * Approval prompt for MCP tool calls. Same pattern as
 * codeCommandApproval.svelte.ts: the executor calls `askMcpApproval` before
 * running anything not provably read-only, the call returns a Promise, a card
 * mounted in the chat view renders the pending request, and the user's button
 * choice resolves it.
 *
 * Choices:
 *   - allow_once:   run it, ask again next time
 *   - allow_always: run it and stop asking for this tool on this server,
 *                   remembered across restarts
 *   - deny:         don't run; the tool returns a denial the model can act on,
 *                   rather than throwing
 *
 * Only one prompt can be pending at a time (the agent loop serializes tool
 * calls). A second overlapping ask rejects.
 *
 * # Why "always" is per tool, per server
 *
 * Not per server: a user who approves `create_issue` has said nothing about
 * `delete_repository`. Not global either — the same tool name means different
 * things on different servers. The pair is the smallest unit the user actually
 * reasoned about when they clicked.
 */

import type { McpToolAnnotations } from '$lib/ipc/gen/McpToolAnnotations';

export type McpApprovalChoice = 'allow_once' | 'allow_always' | 'deny';

export interface McpApprovalRequest {
	/** The configured server's id — the key half of an "always" decision. */
	serverId: string;
	/** Its human label, for the card. */
	serverLabel: string;
	/** The tool's own name, without the `mcp__server__` prefix. */
	toolName: string;
	description: string | null;
	annotations: McpToolAnnotations | null;
	/** The arguments the model actually passed, shown verbatim. */
	args: Record<string, unknown>;
}

interface PendingMcpApproval extends McpApprovalRequest {
	resolve: (choice: McpApprovalChoice) => void;
}

let pending = $state<PendingMcpApproval | null>(null);

export function askMcpApproval(request: McpApprovalRequest): Promise<McpApprovalChoice> {
	if (pending !== null) {
		return Promise.reject(
			new Error(
				'An MCP approval prompt is already pending; ' +
					'a second overlapping request is a bug in the caller.'
			)
		);
	}
	return new Promise<McpApprovalChoice>((resolve) => {
		pending = { ...request, resolve };
	});
}

export function getPendingMcpApproval(): PendingMcpApproval | null {
	return pending;
}

export function resolveMcpApproval(choice: McpApprovalChoice): void {
	const current = pending;
	if (current === null) return;
	pending = null;
	current.resolve(choice);
}

/**
 * Remembered `allow_always` decisions, keyed `<serverId>NUL<toolName>`.
 *
 * A NUL separator rather than a colon, a space or a slash: a server id is a
 * UUID, but a tool name is whatever the server chose to call it, and a
 * separator that can occur inside either half lets two different pairs collide
 * onto one key. Approving one tool must never silently approve another.
 */
const ALWAYS_KEY = 'haruspex.mcp.alwaysAllow';

/**
 * Written as an escape, not a literal: a raw NUL byte in source is invisible in
 * a diff and in most editors, and survives an edit only by luck.
 */
const PAIR_SEP = '\u0000';

function pairKey(serverId: string, toolName: string): string {
	return `${serverId}${PAIR_SEP}${toolName}`;
}

// A plain array rather than a Set: this is persisted, non-reactive data read a
// handful of times per turn, and a Set living in a `.svelte.ts` module reads as
// reactive state that it is not.
function loadAlways(): string[] {
	try {
		const raw = localStorage.getItem(ALWAYS_KEY);
		if (!raw) return [];
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
	} catch {
		// A corrupt store means "nothing is pre-approved", which is the safe
		// reading: the user gets asked again rather than silently not asked.
		return [];
	}
}

function saveAlways(keys: string[]): void {
	try {
		localStorage.setItem(ALWAYS_KEY, JSON.stringify(keys));
	} catch {
		// Persistence is a convenience; failing to store it costs a re-prompt.
	}
}

export function isAlwaysAllowed(serverId: string, toolName: string): boolean {
	return loadAlways().includes(pairKey(serverId, toolName));
}

export function rememberAlwaysAllow(serverId: string, toolName: string): void {
	const key = pairKey(serverId, toolName);
	const keys = loadAlways();
	if (!keys.includes(key)) saveAlways([...keys, key]);
}

/**
 * Forget every remembered approval for one server. Called when a server is
 * removed or reinstalled: the same server id coming back with a different
 * toolset must not inherit approvals the user gave the old one.
 */
export function forgetServerApprovals(serverId: string): void {
	const prefix = `${serverId}${PAIR_SEP}`;
	const keys = loadAlways();
	const kept = keys.filter((key) => !key.startsWith(prefix));
	if (kept.length !== keys.length) saveAlways(kept);
}

/** Drop every remembered approval. Exposed for Settings and for tests. */
export function forgetAllApprovals(): void {
	saveAlways([]);
}

/**
 * Whether a tool may run without asking.
 *
 * `readOnlyHint === true` is the only thing that skips the prompt. Anything
 * else prompts — including, deliberately, **absent annotations**. MCP servers
 * are arbitrary third-party programs; the absence of a claim about safety is
 * not a claim of safety, and defaulting an unannotated tool to "harmless" would
 * put the least-documented servers on the most permissive path.
 */
export function requiresApproval(annotations: McpToolAnnotations | null | undefined): boolean {
	return annotations?.readOnlyHint !== true;
}
