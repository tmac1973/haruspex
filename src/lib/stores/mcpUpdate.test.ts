import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import type { CatalogEntry } from '#lib/ipc/gen/CatalogEntry.ts';
import type { McpToolDescriptor } from '#lib/ipc/gen/McpToolDescriptor.ts';
import type { SetupStep } from '#lib/ipc/gen/SetupStep.ts';
import {
	existingAddonProjects,
	forgetUpdateNotice,
	mcpAttentionCount,
	mcpUpdateResult,
	notifyUpdates,
	refreshUpdateStatuses,
	recoverInterruptedUpdates,
	updatedText,
	updateMcpServer
} from './mcpUpdate.svelte';
import { mcpState, removeMcpServer, startMcpServer } from './mcpServers.svelte';
import { isAlwaysAllowed, rememberAlwaysAllow } from './mcpApproval.svelte';
import { dismissToast, getToasts } from './toasts.svelte';
import { invoke } from '@tauri-apps/api/core';
import { invokeCalls, invokeRouter, type InvokeRoute } from '#lib/testing/invoke.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

const ID = 'srv-up';

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: ID,
		label: 'Browser',
		enabled: true,
		source: { kind: 'catalog', entryId: 'playwright' },
		secrets: {},
		toolEnabled: {},
		proxyUse: 'auto',
		setupComplete: true,
		addonProjects: [],
		...over
	};
}

const BROWSER_STEP: SetupStep = {
	kind: 'command',
	label: 'Download the browser',
	args: ['install-browser'],
	help: null,
	optional: false,
	onUpdate: true
};

const OLD_BROWSER_STEP: SetupStep = { ...BROWSER_STEP, args: ['install-browser', '--old'] };

const SIGN_IN_STEP: SetupStep = { ...BROWSER_STEP, label: 'Sign in', args: [], onUpdate: false };

function entry(over: Partial<CatalogEntry> = {}): CatalogEntry {
	return {
		id: 'playwright',
		name: 'Browser',
		description: 'd',
		homepage: 'h',
		acquisition: { kind: 'npm', package: '@playwright/mcp', version: '0.0.90', bin: 'cli.js' },
		command: { args: [], env: {} },
		defaultTools: [],
		setup: [BROWSER_STEP, SIGN_IN_STEP],
		companion: null,
		provenance: null,
		blockedVersions: [],
		...over
	};
}

function tools(...names: string[]): McpToolDescriptor[] {
	return names.map((name) => ({
		name,
		title: null,
		description: name,
		inputSchema: { type: 'object' },
		annotations: null
	}));
}

const CONNECTION = {
	era: 'modern',
	protocolVersion: '2026-07-28',
	serverName: 'p',
	serverVersion: '1',
	instructions: null
};

/**
 * A backend where every step succeeds and the server's tools change from
 * `before` to `after` across the swap. Override any route to make it fail.
 */
function backend(
	over: Record<string, InvokeRoute> = {},
	before = ['navigate', 'click'],
	after = ['navigate', 'snapshot']
): void {
	let swapped = false;
	vi.mocked(invoke).mockImplementation(
		invokeRouter({
			mcp_update_status: [
				{
					serverId: ID,
					installedVersion: '0.0.83',
					pinnedVersion: '0.0.90',
					updateAvailable: true,
					blockedReason: null
				}
			],
			mcp_calls_in_flight: 0,
			mcp_update_swap: () => {
				swapped = true;
			},
			mcp_update_rollback: () => {
				swapped = false;
			},
			mcp_connection_info: CONNECTION,
			mcp_list_tools: () => tools(...(swapped ? after : before)),
			// What is on disk: the old version's own browser step, told apart
			// from the new one's by its arguments.
			mcp_installed_manifests: () => ({
				[ID]: {
					schema: 1,
					entry: swapped ? entry() : entry({ setup: [OLD_BROWSER_STEP] }),
					packageFiles: [],
					installedAt: '2026-11-02T00:00:00Z'
				}
			}),
			...over
		})
	);
}

/** The commands the update ran, in order, with the start/stop noise kept. */
function sequence(): string[] {
	const interesting = new Set([
		'mcp_update_stage',
		'mcp_calls_in_flight',
		'mcp_stop_server',
		'mcp_update_swap',
		'mcp_run_setup_command',
		'mcp_install_addon',
		'mcp_start_server',
		'mcp_update_commit',
		'mcp_update_rollback'
	]);
	return vi
		.mocked(invoke)
		.mock.calls.map((c) => c[0])
		.filter((cmd) => interesting.has(cmd));
}

async function runningServer(): Promise<void> {
	await startMcpServer(config(), entry());
	expect(mcpState(ID).status.type).toBe('Ready');
	await refreshUpdateStatuses([config()]);
	vi.mocked(invoke).mockClear();
}

beforeEach(async () => {
	vi.mocked(invoke).mockReset();
	vi.mocked(invoke).mockResolvedValue(null);
	await removeMcpServer(ID);
	backend();
});

describe('updating a running server', () => {
	it('stages, swaps, reruns the flagged step, starts, and keeps the new version', async () => {
		await runningServer();
		await updateMcpServer(config(), entry());

		expect(sequence()).toEqual([
			'mcp_update_stage',
			'mcp_calls_in_flight',
			'mcp_stop_server',
			'mcp_update_swap',
			'mcp_run_setup_command',
			'mcp_start_server',
			'mcp_update_commit'
		]);
		// Only the browser download: the sign-in step is not run again.
		expect(invokeCalls(vi.mocked(invoke), 'mcp_run_setup_command')).toEqual([
			expect.objectContaining({ args: ['install-browser'] })
		]);
		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpUpdateResult(ID)).toEqual({
			ok: true,
			text: 'Updated to 0.0.90. 1 tool added, 1 removed. Approvals were reset.',
			detail: 'Added: snapshot\nRemoved: click'
		});
	});

	it('forgets the approvals given to the old version', async () => {
		await runningServer();
		rememberAlwaysAllow(ID, 'navigate');
		await updateMcpServer(config(), entry());
		expect(isAlwaysAllowed(ID, 'navigate')).toBe(false);
	});

	it('updates the addon in each recorded project', async () => {
		await runningServer();
		const addon: SetupStep = {
			kind: 'addon',
			label: 'Addon',
			url: 'https://e.test/a.zip',
			sha256: 'x',
			marker: 'project.godot',
			installPath: 'addons/x',
			help: null,
			optional: false
		};
		await updateMcpServer(
			config({ addonProjects: ['/p/one', '/p/two'] }),
			entry({ setup: [addon] })
		);
		expect(invokeCalls(vi.mocked(invoke), 'mcp_install_addon')).toEqual([
			expect.objectContaining({ stepIndex: 0, targetDir: '/p/one' }),
			expect.objectContaining({ stepIndex: 0, targetDir: '/p/two' })
		]);
		expect(sequence()).toContain('mcp_update_commit');
	});
});

describe('an update that cannot go ahead', () => {
	it('leaves the running server alone when the download fails', async () => {
		await runningServer();
		backend({
			mcp_update_stage: () => {
				throw 'network down';
			}
		});
		await updateMcpServer(config(), entry());

		expect(sequence()).toEqual(['mcp_update_stage']);
		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpUpdateResult(ID)).toEqual({
			ok: false,
			text: 'Update failed; version 0.0.83 is still installed.',
			detail: 'network down'
		});
	});

	it('does not stop a server with a tool call under way', async () => {
		await runningServer();
		backend({ mcp_calls_in_flight: 1 });
		await updateMcpServer(config(), entry());

		expect(sequence()).not.toContain('mcp_stop_server');
		expect(sequence()).toContain('mcp_update_rollback');
		expect(mcpUpdateResult(ID)?.text).toBe(
			'A tool from this server is running. Try again when it finishes.'
		);
		// Its tools are back.
		expect(mcpState(ID).tools.map((t) => t.name)).toEqual(['navigate', 'click']);
	});
});

describe('an update that fails after the swap', () => {
	it('rolls back and restarts the old version when a setup step fails', async () => {
		await runningServer();
		let runs = 0;
		backend({
			mcp_run_setup_command: () => {
				runs += 1;
				if (runs === 1) throw 'download failed';
			}
		});
		await updateMcpServer(config(), entry());

		const seq = sequence();
		expect(seq).not.toContain('mcp_update_commit');
		// The old version's own browser step runs again before it restarts.
		expect(seq.slice(seq.indexOf('mcp_update_rollback'))).toEqual([
			'mcp_update_rollback',
			'mcp_run_setup_command',
			'mcp_start_server'
		]);
		expect(invokeCalls(vi.mocked(invoke), 'mcp_run_setup_command').at(-1)).toMatchObject({
			args: ['install-browser', '--old']
		});
		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpState(ID).tools.map((t) => t.name)).toEqual(['navigate', 'click']);
		expect(mcpUpdateResult(ID)).toMatchObject({
			ok: false,
			text: 'Update failed; version 0.0.83 is still installed.'
		});
	});

	it('rolls back when the new version will not start', async () => {
		await runningServer();
		let starts = 0;
		backend({
			mcp_start_server: () => {
				starts += 1;
				if (starts === 1) throw 'crashed on launch';
			}
		});
		await updateMcpServer(config(), entry());

		expect(sequence()).toContain('mcp_update_rollback');
		expect(sequence()).not.toContain('mcp_update_commit');
		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpUpdateResult(ID)?.detail).toContain('crashed on launch');
		// The new version's browser step succeeded and may have removed the old
		// browser, so the old version's step runs again.
		expect(invokeCalls(vi.mocked(invoke), 'mcp_run_setup_command').map((c) => c?.args)).toEqual([
			['install-browser'],
			['install-browser', '--old']
		]);
	});

	it('says so when the old version’s setup cannot be redone, and still restarts it', async () => {
		await runningServer();
		let starts = 0;
		let runs = 0;
		backend({
			mcp_start_server: () => {
				starts += 1;
				if (starts === 1) throw 'crashed on launch';
			},
			mcp_run_setup_command: () => {
				runs += 1;
				if (runs === 2) throw 'offline';
			}
		});
		await updateMcpServer(config(), entry());

		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpUpdateResult(ID)).toEqual({
			ok: false,
			text: 'Update failed; version 0.0.83 is back, but its setup needs running again (Setup).',
			detail: 'crashed on launch\noffline'
		});
	});

	it('does not redo setup when the update failed before any ran', async () => {
		await runningServer();
		backend({
			mcp_update_swap: () => {
				throw 'disk full';
			}
		});
		await updateMcpServer(config(), entry());
		expect(sequence()).not.toContain('mcp_run_setup_command');
	});

	it('keeps the approvals when the update did not happen', async () => {
		await runningServer();
		rememberAlwaysAllow(ID, 'navigate');
		backend({
			mcp_update_swap: () => {
				throw 'disk full';
			}
		});
		await updateMcpServer(config(), entry());
		expect(isAlwaysAllowed(ID, 'navigate')).toBe(true);
	});
});

describe('servers that were not running', () => {
	it('checks the new version starts, then stops it again', async () => {
		await refreshUpdateStatuses([config()]);
		vi.mocked(invoke).mockClear();
		await updateMcpServer(config(), entry());

		expect(sequence()).toContain('mcp_start_server');
		expect(sequence().at(-1)).toBe('mcp_update_commit');
		expect(mcpState(ID).status.type).toBe('Stopped');
		expect(mcpUpdateResult(ID)?.text).toBe('Updated to 0.0.90. Approvals were reset.');
	});

	it('leaves a server that was only stopped by its block running', async () => {
		backend({
			mcp_start_server: () => {
				throw 'BLOCKED_VERSION:Runs any page’s script.';
			}
		});
		await startMcpServer(config(), entry());
		expect(mcpState(ID).blockedReason).not.toBeNull();

		backend();
		await updateMcpServer(config(), entry());
		expect(mcpState(ID).status.type).toBe('Ready');
		expect(mcpState(ID).blockedReason).toBeNull();
	});

	it('skips the start check for a server whose setup is unfinished', async () => {
		await updateMcpServer(config({ setupComplete: false }), entry());
		expect(sequence()).not.toContain('mcp_start_server');
		expect(sequence()).toContain('mcp_update_commit');
	});
});

describe('the result line', () => {
	it('leaves out the parts that are zero', () => {
		expect(updatedText('2', ['a'], ['a', 'b']).text).toBe(
			'Updated to 2. 1 tool added. Approvals were reset.'
		);
		expect(updatedText('2', ['a', 'b', 'c'], ['a']).text).toBe(
			'Updated to 2. 2 removed. Approvals were reset.'
		);
		expect(updatedText('2', ['a'], ['a'])).toEqual({
			ok: true,
			text: 'Updated to 2. Approvals were reset.',
			detail: null
		});
	});
});

describe('around an update', () => {
	it('lists only the addon projects that still exist', async () => {
		backend({ mcp_existing_dirs: ['/p/one'] });
		expect(await existingAddonProjects(config({ addonProjects: ['/p/one', '/p/gone'] }))).toEqual([
			'/p/one'
		]);
		vi.mocked(invoke).mockClear();
		expect(await existingAddonProjects(config())).toEqual([]);
		expect(invoke).not.toHaveBeenCalled();
	});

	it('says so when a previous run’s update had to be undone', async () => {
		backend({ mcp_update_recover: ['srv-x'] });
		await recoverInterruptedUpdates();
		expect(getToasts().map((t) => t.message)).toContain(
			'An MCP server update was interrupted and has been undone.'
		);
	});
});

describe('telling the user', () => {
	type Status = {
		serverId: string;
		installedVersion: string;
		pinnedVersion: string;
		updateAvailable: boolean;
		blockedReason: string | null;
	};
	const status = (serverId: string, over: Partial<Status> = {}): Status => ({
		serverId,
		installedVersion: '1',
		pinnedVersion: '2',
		updateAvailable: true,
		blockedReason: null,
		...over
	});
	const servers = [config({ id: 'a', label: 'GitHub' }), config({ id: 'b', label: 'Browser' })];

	async function launchWith(...found: Status[]): Promise<string[]> {
		for (const t of getToasts()) dismissToast(t.id);
		backend({ mcp_update_status: found });
		await refreshUpdateStatuses(servers);
		notifyUpdates(servers);
		return getToasts().map((t) => t.message);
	}

	beforeEach(() => {
		localStorage.clear();
	});

	it('toasts a new pin once, then leaves it to the badge', async () => {
		expect(await launchWith(status('a'), status('b'))).toEqual([
			'2 MCP servers have updates. Settings → MCP servers.'
		]);
		expect(mcpAttentionCount()).toBe(2);
		expect(await launchWith(status('a'), status('b'))).toEqual([]);
	});

	it('toasts again for a newer pin', async () => {
		await launchWith(status('a'));
		expect(await launchWith(status('a', { pinnedVersion: '3' }))).toEqual([
			'1 MCP server has an update. Settings → MCP servers.'
		]);
	});

	it('toasts a blocked version on every launch, naming it', async () => {
		const blocked = status('b', { blockedReason: 'Leaks tokens.' });
		const message = 'Browser was stopped for a security problem: Leaks tokens.';
		expect(await launchWith(blocked)).toEqual([message]);
		expect(await launchWith(blocked)).toEqual([message]);
	});

	it('counts several blocked servers in one toast', async () => {
		expect(
			await launchWith(status('a', { blockedReason: 'x' }), status('b', { blockedReason: 'y' }))
		).toEqual(['2 MCP servers were stopped for security problems. Settings → MCP servers.']);
	});

	it('says nothing, and shows no badge, when everything is current', async () => {
		expect(await launchWith(status('a', { updateAvailable: false }))).toEqual([]);
		expect(mcpAttentionCount()).toBe(0);
	});

	it('still toasts when storage cannot be read or written', async () => {
		const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
			throw new Error('denied');
		});
		const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
			throw new Error('denied');
		});
		try {
			expect(await launchWith(status('a'))).toHaveLength(1);
		} finally {
			get.mockRestore();
			set.mockRestore();
		}
	});

	it('forgets a removed server, so a reinstall is told again', async () => {
		await launchWith(status('a'));
		forgetUpdateNotice('a');
		expect(await launchWith(status('a'))).toHaveLength(1);
	});
});
