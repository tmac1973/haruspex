import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import type { CatalogEntry } from '$lib/ipc/gen/CatalogEntry';
import type { McpToolDescriptor } from '$lib/ipc/gen/McpToolDescriptor';
import { IPC } from '$lib/ipc/commands';
import {
	companionWarning,
	mcpState,
	probeCompanion,
	removeMcpServer,
	startEnabledMcpServers,
	startMcpServer,
	statusLabel,
	stopMcpServer,
	type McpRuntimeState
} from './mcpServers.svelte';
import { registeredMcpToolNames } from '$lib/agent/tools/mcp';
import { isAlwaysAllowed, rememberAlwaysAllow } from './mcpApproval.svelte';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));

const ID = 'srv-1';

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: ID,
		label: 'GitHub',
		enabled: true,
		source: { kind: 'catalog', entryId: 'github' },
		secrets: {},
		toolEnabled: {},
		setupComplete: true,
		...over
	};
}

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		id: 'github',
		name: 'GitHub',
		description: 'd',
		homepage: 'h',
		acquisition: { kind: 'npm', package: 'p', version: '1.0.0', bin: 'p/i.js' },
		command: { args: [], env: {} },
		defaultTools: ['search'],
		setup: [],
		companion: null,
		provenance: null,
		...over
	};
}

const TOOLS: McpToolDescriptor[] = [
	{
		name: 'search',
		title: null,
		description: 'search things',
		inputSchema: { type: 'object' },
		annotations: null
	}
];

/** Wire up the happy path: spawn config, start, connection info, tool list. */
function mockHappyStart(): void {
	invoke.mockImplementation((cmd: string) => {
		switch (cmd) {
			case IPC.mcp_spawn_config:
				return Promise.resolve({ id: ID, program: '/x/node', args: [], env: [], cwd: null });
			case IPC.mcp_start_server:
				return Promise.resolve(null);
			case IPC.mcp_connection_info:
				return Promise.resolve({
					era: 'modern',
					protocolVersion: '2026-07-28',
					serverName: 'github',
					serverVersion: '1.0.0',
					instructions: null
				});
			case IPC.mcp_list_tools:
				return Promise.resolve(TOOLS);
			default:
				return Promise.resolve(null);
		}
	});
}

beforeEach(async () => {
	invoke.mockReset();
	invoke.mockResolvedValue(null);
	await stopMcpServer(ID);
});

describe('starting a server', () => {
	it('reaches ready and registers its tools', async () => {
		mockHappyStart();
		await startMcpServer(config(), entry());

		const state = mcpState(ID);
		expect(state.status.type).toBe('Ready');
		expect(state.connection?.protocolVersion).toBe('2026-07-28');
		expect(state.tools).toHaveLength(1);
		expect(registeredMcpToolNames()).toContain('mcp__srv-1__search');
	});

	it('shows the protocol version in the status line', async () => {
		mockHappyStart();
		await startMcpServer(config(), entry());
		expect(statusLabel(mcpState(ID))).toBe('Running · MCP 2026-07-28');
	});

	it('lands in error with the reason when the spawn config is refused', async () => {
		// The unfinished-setup case: refusing here is what turns "it did
		// nothing" into a sentence the user can act on.
		invoke.mockRejectedValue('GitHub has not finished its setup');
		await startMcpServer(config({ setupComplete: false }), entry());

		const state = mcpState(ID);
		expect(state.status.type).toBe('Error');
		expect(state.error).toContain('has not finished its setup');
		expect(state.busy).toBe(false);
	});

	it('registers no tools when a later step fails', async () => {
		// A partial success is a server that looks running with no tools, which
		// is the worst of both: the row says fine and the model has nothing.
		invoke.mockImplementation((cmd: string) => {
			if (cmd === IPC.mcp_list_tools) return Promise.reject('tools/list failed');
			if (cmd === IPC.mcp_spawn_config)
				return Promise.resolve({ id: ID, program: '/x/node', args: [], env: [], cwd: null });
			return Promise.resolve(null);
		});
		await startMcpServer(config(), entry());

		expect(mcpState(ID).status.type).toBe('Error');
		expect(registeredMcpToolNames()).not.toContain('mcp__srv-1__search');
	});
});

describe('stopping a server', () => {
	it('withdraws its tools and clears the connection', async () => {
		mockHappyStart();
		await startMcpServer(config(), entry());
		expect(registeredMcpToolNames()).toContain('mcp__srv-1__search');

		invoke.mockResolvedValue(null);
		await stopMcpServer(ID);

		const state = mcpState(ID);
		expect(state.status.type).toBe('Stopped');
		expect(state.connection).toBeNull();
		expect(state.tools).toEqual([]);
		expect(registeredMcpToolNames()).not.toContain('mcp__srv-1__search');
	});

	it('withdraws the tools even when the stop itself fails', async () => {
		// The agent must never be able to call into a server we have given up
		// on, whatever the backend said.
		mockHappyStart();
		await startMcpServer(config(), entry());

		invoke.mockRejectedValue('kill failed');
		await stopMcpServer(ID);

		expect(mcpState(ID).status.type).toBe('Error');
		expect(registeredMcpToolNames()).not.toContain('mcp__srv-1__search');
	});
});

describe('removing a server', () => {
	it('forgets the approvals the user gave it', async () => {
		// The same id can come back from a reinstall with a different toolset.
		// Inheriting "always allow" would approve tools the user never saw.
		rememberAlwaysAllow(ID, 'create_issue');
		expect(isAlwaysAllowed(ID, 'create_issue')).toBe(true);

		invoke.mockResolvedValue(null);
		await removeMcpServer(ID);

		expect(isAlwaysAllowed(ID, 'create_issue')).toBe(false);
	});
});

describe('starting everything on launch', () => {
	it('carries on past a failure so one broken server does not hide the rest', async () => {
		const first = config({ id: 'a', label: 'A' });
		const second = config({ id: 'b', label: 'B' });
		invoke.mockImplementation((cmd: string, args?: Record<string, unknown>) => {
			const cfg = args?.config as { id?: string } | undefined;
			if (cmd === IPC.mcp_spawn_config) {
				return cfg?.id === 'a'
					? Promise.reject('a is broken')
					: Promise.resolve({ id: 'b', program: '/x/node', args: [], env: [], cwd: null });
			}
			if (cmd === IPC.mcp_list_tools) return Promise.resolve([]);
			if (cmd === IPC.mcp_connection_info) return Promise.resolve(null);
			return Promise.resolve(null);
		});

		await startEnabledMcpServers([first, second], [entry()]);

		expect(mcpState('a').status.type).toBe('Error');
		expect(mcpState('b').status.type).toBe('Ready');
		await stopMcpServer('a');
		await stopMcpServer('b');
	});
});

describe('status labels', () => {
	const runtime = (over: Partial<McpRuntimeState>): McpRuntimeState => ({
		status: { type: 'Stopped' },
		connection: null,
		tools: [],
		companion: { kind: 'unknown' },
		error: null,
		busy: false,
		...over
	});

	it('reads plainly in every state', () => {
		expect(statusLabel(runtime({ status: { type: 'Stopped' } }))).toBe('Stopped');
		expect(statusLabel(runtime({ status: { type: 'Starting' }, busy: true }))).toBe('Starting…');
		expect(
			statusLabel(runtime({ status: { type: 'Error', message: 'boom' }, error: 'boom' }))
		).toBe('Failed');
	});

	it('omits the version when a server is running but did not report one', () => {
		expect(statusLabel(runtime({ status: { type: 'Ready' } }))).toBe('Running');
	});
});

describe('companion applications', () => {
	const runtime = (over: Partial<McpRuntimeState>): McpRuntimeState => ({
		status: { type: 'Ready' },
		connection: null,
		tools: [],
		companion: { kind: 'unknown' },
		error: null,
		busy: false,
		...over
	});

	it('says nothing for a server with no companion at all', () => {
		// `unknown` is not a problem to report — most servers have no companion.
		expect(companionWarning(runtime({}))).toBeNull();
	});

	it('says nothing while the companion is attached', () => {
		expect(companionWarning(runtime({ companion: { kind: 'connected' } }))).toBeNull();
	});

	it("shows the catalog entry's own hint when it is not", () => {
		// Carried through rather than composed here: a third companion entry
		// must be a JSON change, not a code change.
		const warning = companionWarning(
			runtime({ companion: { kind: 'disconnected', hint: 'Press N, then Start MCP Server.' } })
		);
		expect(warning).toBe('Press N, then Start MCP Server.');
	});

	it('says nothing about a companion when the server is not running', () => {
		// "Blender is not connected" under a stopped server is noise: of course
		// it is not, nothing is asking it.
		expect(
			companionWarning(
				runtime({
					status: { type: 'Stopped' },
					companion: { kind: 'disconnected', hint: 'Open Blender.' }
				})
			)
		).toBeNull();
	});

	it('probes a catalog server and records the answer', async () => {
		invoke.mockResolvedValue({ kind: 'disconnected', hint: 'Open Blender.' });
		const status = await probeCompanion(config({ id: 'blender-1' }));
		expect(status).toEqual({ kind: 'disconnected', hint: 'Open Blender.' });
		expect(mcpState('blender-1').companion).toEqual({
			kind: 'disconnected',
			hint: 'Open Blender.'
		});
	});

	it('treats a probe that could not run as unknown, not as missing', async () => {
		// A failed probe is not evidence the application is absent, and telling
		// the user to go and start something that is already running is worse
		// than saying nothing.
		invoke.mockRejectedValue('server is not connected');
		expect(await probeCompanion(config({ id: 'blender-2' }))).toEqual({ kind: 'unknown' });
	});

	it('passes no entry id for a custom server, which cannot have a companion', async () => {
		invoke.mockResolvedValue({ kind: 'unknown' });
		await probeCompanion(
			config({ id: 'custom-1', source: { kind: 'custom', program: '/x/srv', args: [] } })
		);
		expect(invoke).toHaveBeenCalledWith(IPC.mcp_probe_companion, {
			id: 'custom-1',
			entryId: null
		});
	});
});
