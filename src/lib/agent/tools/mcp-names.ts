/**
 * MCP tool naming and per-tool enablement.
 *
 * Split out of `mcp.ts` to break a cycle: `mcp.ts` registers *through*
 * `registry.ts`, so `registry.ts` cannot import it back — the same reason
 * `registry.ts` imports `memoryActive()` rather than the memory tool module.
 * Both sides import this instead, and it imports only settings.
 */

import { startableMcpServers } from '$lib/stores/settings';

/** Separator between the prefix, the server id and the tool name. */
const NAME_SEP = '__';
const NAME_PREFIX = 'mcp';

/**
 * `mcp__<serverId>__<toolName>`.
 *
 * Two servers exposing `search` must not collide, and the prefix makes it
 * obvious in the UI and in logs where a tool came from.
 */
export function mcpToolName(serverId: string, toolName: string): string {
	return `${NAME_PREFIX}${NAME_SEP}${serverId}${NAME_SEP}${toolName}`;
}

/**
 * Split a registered name back into its parts.
 *
 * Bounded rather than a plain split: a server may legitimately name a tool
 * `read__file`, and splitting on every separator would mangle it. Two splits,
 * then everything remaining is the tool's own name.
 */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
	if (!name.startsWith(`${NAME_PREFIX}${NAME_SEP}`)) return null;
	const rest = name.slice(NAME_PREFIX.length + NAME_SEP.length);
	const sep = rest.indexOf(NAME_SEP);
	if (sep <= 0) return null;
	const serverId = rest.slice(0, sep);
	const toolName = rest.slice(sep + NAME_SEP.length);
	return toolName ? { serverId, toolName } : null;
}

/**
 * The catalog's tested default tool list, per running server.
 *
 * Held here rather than read from the catalog on demand because resolution
 * happens inside `getToolSchemas`, which is synchronous and on the hot path of
 * every request; the catalog lives behind an async command. The server manager
 * records it when it starts a server.
 */
const defaults = new Map<string, string[]>();

export function setMcpDefaultTools(serverId: string, toolNames: string[]): void {
	defaults.set(serverId, [...toolNames]);
}

export function clearMcpDefaultTools(serverId: string): void {
	defaults.delete(serverId);
}

export function mcpDefaultTools(serverId: string): string[] {
	return defaults.get(serverId) ?? [];
}

/**
 * Whether an MCP tool is switched on for its server.
 *
 * Resolution order, and the reason for it: an explicit per-tool decision by the
 * user always wins; absent one, the catalog entry's tested `defaultTools` is
 * what shipped enabled. A tool the user has never seen and the catalog never
 * vouched for stays **off** — enabling everything by default is exactly how a
 * 30-tool server wrecks tool selection on the small tiers.
 *
 * A server that is not startable has no enabled tools at all, so disabling a
 * server withdraws its tools without needing a second mechanism.
 */
export function isMcpToolEnabled(name: string): boolean {
	const parsed = parseMcpToolName(name);
	if (!parsed) return false;
	const server = startableMcpServers().find((s) => s.id === parsed.serverId);
	if (!server) return false;
	const explicit = server.toolEnabled[parsed.toolName];
	if (typeof explicit === 'boolean') return explicit;
	return mcpDefaultTools(parsed.serverId).includes(parsed.toolName);
}
