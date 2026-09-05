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
import type { CompanionStatus } from '$lib/ipc/gen/CompanionStatus';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
import { registerMcpTools, setToolFailureHook, unregisterMcpServer } from '$lib/agent/tools/mcp';
import { forgetServerApprovals } from './mcpApproval.svelte';
import { getSettings } from './settings';

/** Everything the UI knows about one server right now. */
export interface McpRuntimeState {
	status: SidecarStatus;
	connection: McpConnectionInfo | null;
	tools: McpToolDescriptor[];
	/**
	 * Whether the third-party application this server bridges to is reachable.
	 * `unknown` for a server with no companion at all, which the UI reads as
	 * "nothing to say" rather than as a problem.
	 */
	companion: CompanionStatus;
	/** Why the last start failed, when it did. */
	error: string | null;
	/** True while a start or stop is in flight, so the row can disable itself. */
	busy: boolean;
}

const STOPPED: SidecarStatus = { type: 'Stopped' };

function blank(): McpRuntimeState {
	return {
		status: STOPPED,
		connection: null,
		tools: [],
		companion: { kind: 'unknown' },
		error: null,
		busy: false
	};
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
	configs[config.id] = config;
	patch(config.id, { busy: true, error: null, status: { type: 'Starting' } });
	try {
		if (config.source.kind === 'remote') {
			// A remote server has no spawn configuration at all — no program, no
			// arguments, no environment — so it takes its own path rather than
			// threading an empty one through the stdio machinery. The proxy goes
			// with it: a user who configured one must not find that MCP quietly
			// connects direct.
			await invoke(IPC.mcp_connect_remote_server, {
				config,
				proxy: getSettings().proxy
			});
		} else {
			const spawn = await invoke<SpawnConfig>(IPC.mcp_spawn_config, { config });
			await invoke(IPC.mcp_start_server, { config: spawn });
		}

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
		// Probed after the row is already Ready, not before: a companion that is
		// not running is not a reason to call the server broken, and the user
		// should watch it come up and *then* be told what is still missing.
		await probeCompanion(config);
	} catch (e) {
		const message = String(e);
		// Withdraw anything a previous run left registered: a half-started
		// server must not leave callable tools behind.
		unregisterMcpServer(config.id);
		patch(config.id, {
			status: { type: 'Error', message },
			connection: null,
			tools: [],
			companion: { kind: 'unknown' },
			error: message,
			busy: false
		});
	}
}

/**
 * Ask whether a server's companion application is reachable, and record it.
 *
 * A server with no companion answers `unknown` and costs one round trip. Called
 * on start, from the row's "Check again", on the settings panel's slow poll,
 * and after a failed tool call — a failed call is the strongest signal the
 * companion dropped.
 */
export async function probeCompanion(config: McpServerConfig): Promise<CompanionStatus> {
	const entryId = config.source.kind === 'catalog' ? config.source.entryId : null;
	try {
		const companion = await invoke<CompanionStatus>(IPC.mcp_probe_companion, {
			id: config.id,
			entryId
		});
		patch(config.id, { companion });
		return companion;
	} catch {
		// A probe that could not run is not evidence the application is missing.
		patch(config.id, { companion: { kind: 'unknown' } });
		return { kind: 'unknown' };
	}
}

/** Stop a server and withdraw its tools. Idempotent. */
export async function stopMcpServer(serverId: string): Promise<void> {
	patch(serverId, { busy: true });
	unregisterMcpServer(serverId);
	try {
		await invoke(IPC.mcp_stop_server, { id: serverId });
		patch(serverId, {
			status: STOPPED,
			connection: null,
			tools: [],
			companion: { kind: 'unknown' },
			error: null,
			busy: false
		});
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
	delete configs[serverId];
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

/**
 * The second status line: what is wrong when the process is fine but the
 * application it bridges to is not there. Null when there is nothing to say.
 *
 * The text is the catalog entry's own hint, carried through rather than
 * composed here — a third companion entry must be a JSON change.
 */
export function companionWarning(state: McpRuntimeState): string | null {
	return state.status.type === 'Ready' && state.companion.kind === 'disconnected'
		? state.companion.hint
		: null;
}

/**
 * Configurations by server id, so a failed tool call can re-probe without the
 * caller having to hand the config back. Populated on start.
 *
 * A plain object rather than a Map: nothing renders from it, so it is not
 * reactive state, and a Map living in a `.svelte.ts` module reads as though it
 * were.
 */
const configs: Record<string, McpServerConfig> = {};

// Re-probe the companion whenever a tool call fails. Registered once at module
// load: a failed call is the strongest signal an application has dropped, and
// re-probing here is what turns "it failed" into "Blender is not running".
setToolFailureHook((serverId) => {
	const config = configs[serverId];
	if (config) void probeCompanion(config);
});

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
