/**
 * Live state for configured MCP servers: whether each is running, what protocol
 * it settled on, and which tools it published.
 *
 * Settings own the *configuration* (`settings.integrations.mcp.servers`); this
 * owns everything that is only true while the app is running. Keeping the two
 * apart is what lets a server be reconfigured without restarting it, and a
 * server to crash without the user's settings changing underneath them.
 *
 * The store is also what connects the two halves of the feature: when a server
 * reaches ready it lists its tools and registers them with the agent's tool
 * registry, and when it stops it withdraws them. Nothing else has both facts.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { SidecarStatus } from '$lib/ipc/gen/SidecarStatus';
import type { SpawnConfig } from '$lib/ipc/gen/SpawnConfig';
import type { McpConnectionInfo } from '$lib/ipc/gen/McpConnectionInfo';
import type { McpToolDescriptor } from '$lib/ipc/gen/McpToolDescriptor';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
import { registerMcpTools, unregisterMcpServer } from '$lib/agent/tools/mcp';
import { forgetServerApprovals } from './mcpApproval.svelte';

/** Everything the UI knows about one server right now. */
export interface McpRuntimeState {
	status: SidecarStatus;
	connection: McpConnectionInfo | null;
	tools: McpToolDescriptor[];
	/** Why the last start failed, when it did. */
	error: string | null;
	/** True while a start or stop is in flight, so the row can disable itself. */
	busy: boolean;
}

const STOPPED: SidecarStatus = { type: 'Stopped' };

function blank(): McpRuntimeState {
	return { status: STOPPED, connection: null, tools: [], error: null, busy: false };
}

const states = $state<Record<string, McpRuntimeState>>({});

/** Current state for a server, never null — an unknown server reads as stopped. */
export function mcpState(serverId: string): McpRuntimeState {
	return states[serverId] ?? blank();
}

export function allMcpStates(): Record<string, McpRuntimeState> {
	return states;
}

function patch(serverId: string, next: Partial<McpRuntimeState>): void {
	states[serverId] = { ...(states[serverId] ?? blank()), ...next };
}

/**
 * Start a configured server and expose its tools.
 *
 * The whole sequence — build the spawn config, spawn and negotiate, list tools,
 * register them — is one operation from the user's point of view, and a partial
 * success is a server that looks running with no tools. So any step failing
 * lands the row in `Error` with the reason.
 */
export async function startMcpServer(
	config: McpServerConfig,
	catalogEntry: CatalogEntry | null
): Promise<void> {
	patch(config.id, { busy: true, error: null, status: { type: 'Starting' } });
	try {
		const spawn = await invoke<SpawnConfig>(IPC.mcp_spawn_config, { config });
		await invoke(IPC.mcp_start_server, { config: spawn });

		const [connection, tools] = await Promise.all([
			invoke<McpConnectionInfo | null>(IPC.mcp_connection_info, { id: config.id }),
			invoke<McpToolDescriptor[]>(IPC.mcp_list_tools, { id: config.id })
		]);

		registerMcpTools(config.id, config.label, tools, catalogEntry?.defaultTools ?? []);
		patch(config.id, {
			status: { type: 'Ready' },
			connection,
			tools,
			error: null,
			busy: false
		});
	} catch (e) {
		const message = String(e);
		// Withdraw anything a previous run left registered: a half-started
		// server must not leave callable tools behind.
		unregisterMcpServer(config.id);
		patch(config.id, {
			status: { type: 'Error', message },
			connection: null,
			tools: [],
			error: message,
			busy: false
		});
	}
}

/** Stop a server and withdraw its tools. Idempotent. */
export async function stopMcpServer(serverId: string): Promise<void> {
	patch(serverId, { busy: true });
	unregisterMcpServer(serverId);
	try {
		await invoke(IPC.mcp_stop_server, { id: serverId });
		patch(serverId, { status: STOPPED, connection: null, tools: [], error: null, busy: false });
	} catch (e) {
		// The tools are already withdrawn, so the agent is safe either way; the
		// row still has to say the stop did not go cleanly.
		patch(serverId, { status: { type: 'Error', message: String(e) }, busy: false });
	}
}

/**
 * Stop a server, remove its files, and forget what the user approved for it.
 *
 * The approvals matter: the same server id can come back from a reinstall with
 * a different toolset, and inheriting "always allow" decisions the user made
 * about the old one would approve tools they never saw.
 */
export async function removeMcpServer(serverId: string): Promise<void> {
	await stopMcpServer(serverId);
	forgetServerApprovals(serverId);
	try {
		await invoke(IPC.mcp_uninstall_server, { serverId });
	} catch (e) {
		patch(serverId, { error: String(e) });
		return;
	}
	delete states[serverId];
}

/** The tail of a server's stderr, for the inline diagnostic in an error row. */
export async function mcpServerLogs(serverId: string): Promise<string[]> {
	try {
		return await invoke<string[]>(IPC.mcp_server_logs, { id: serverId });
	} catch {
		return [];
	}
}

/**
 * Start every server the settings say should be running.
 *
 * Sequential rather than parallel: each start spawns a child process and may
 * negotiate for several seconds, and a user with four servers watching four
 * rows flicker at once learns less than one watching them come up in order.
 * Failures do not stop the rest — one broken server must not hide the others.
 */
export async function startEnabledMcpServers(
	configs: McpServerConfig[],
	catalog: CatalogEntry[]
): Promise<void> {
	for (const config of configs) {
		const entryId = config.source.kind === 'catalog' ? config.source.entryId : null;
		const entry = entryId ? (catalog.find((e) => e.id === entryId) ?? null) : null;
		await startMcpServer(config, entry);
	}
}

/** Human-readable one-liner for a status, for the row and for tests. */
export function statusLabel(state: McpRuntimeState): string {
	switch (state.status.type) {
		case 'Ready':
			return state.connection ? `Running · MCP ${state.connection.protocolVersion}` : 'Running';
		case 'Starting':
			return 'Starting…';
		case 'Error':
			return 'Failed';
		default:
			return 'Stopped';
	}
}
