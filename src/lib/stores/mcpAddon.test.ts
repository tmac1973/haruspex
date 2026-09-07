import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { McpServerConfig } from '$lib/ipc/gen/McpServerConfig';
import type { SetupStep } from '$lib/ipc/gen/SetupStep';

const invoke = vi.hoisted(() => vi.fn());
const openFileDialog = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: openFileDialog }));
vi.mock('$lib/stores/settings', () => ({ getSettings: () => ({ proxy: { mode: 'off' } }) }));

const { addonStepIndex, pickAndInstallAddon } = await import('./mcpAddon');

const addon: SetupStep = {
	kind: 'addon',
	label: 'Install the Godot plugin',
	url: 'https://example.test/addon.zip',
	sha256: 'a'.repeat(64),
	marker: 'project.godot',
	installPath: 'addons/godot_mcp',
	help: null,
	optional: false
};
const instruction: SetupStep = {
	kind: 'instruction',
	title: 'Install Godot',
	text: 'Go and do it.',
	link: null
};

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: 'srv-1',
		label: 'Godot',
		enabled: true,
		source: { kind: 'catalog', entryId: 'godot' },
		secrets: {},
		toolEnabled: {},
		proxyUse: 'auto',
		setupComplete: false,
		addonProjects: [],
		...over
	};
}

beforeEach(() => {
	invoke.mockReset();
	openFileDialog.mockReset();
});

describe('finding the addon step', () => {
	it('reports the index so the backend can be told which step to run', () => {
		expect(addonStepIndex([instruction, addon])).toBe(1);
	});

	it('reports null for an entry that installs no addon', () => {
		expect(addonStepIndex([instruction])).toBeNull();
	});
});

describe('installing into a project', () => {
	it('records the chosen directory against the server', async () => {
		openFileDialog.mockResolvedValue('/home/me/game');
		invoke.mockResolvedValue('/home/me/game/addons/godot_mcp');

		const done = await pickAndInstallAddon(config(), 1);

		expect(done?.next.addonProjects).toEqual(['/home/me/game']);
		expect(done?.installedAt).toBe('/home/me/game/addons/godot_mcp');
		// The step index goes over the wire, not the URL or the checksum: those
		// come from the bundled catalog on the Rust side.
		expect(invoke).toHaveBeenCalledWith(
			'mcp_install_addon',
			expect.objectContaining({ entryId: 'godot', stepIndex: 1, targetDir: '/home/me/game' })
		);
	});

	it('treats a dismissed picker as a cancel, not a failure', async () => {
		openFileDialog.mockResolvedValue(null);
		await expect(pickAndInstallAddon(config(), 1)).resolves.toBeNull();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('keeps a second project alongside the first', async () => {
		openFileDialog.mockResolvedValue('/home/me/other');
		invoke.mockResolvedValue('/home/me/other/addons/godot_mcp');

		const done = await pickAndInstallAddon(config({ addonProjects: ['/home/me/game'] }), 1);
		expect(done?.next.addonProjects).toEqual(['/home/me/game', '/home/me/other']);
	});

	it('does not list the same project twice when the addon is updated', async () => {
		// Re-running it on a project is how a user takes a new addon version.
		openFileDialog.mockResolvedValue('/home/me/game');
		invoke.mockResolvedValue('/home/me/game/addons/godot_mcp');

		const done = await pickAndInstallAddon(config({ addonProjects: ['/home/me/game'] }), 1);
		expect(done?.next.addonProjects).toEqual(['/home/me/game']);
	});

	it('surfaces the backend message rather than a generic failure', async () => {
		// "that folder has no project.godot" is the whole value of the error.
		openFileDialog.mockResolvedValue('/home/me/Downloads');
		invoke.mockRejectedValue(
			'/home/me/Downloads does not look like the right folder — it has no project.godot'
		);

		await expect(pickAndInstallAddon(config(), 1)).rejects.toContain('project.godot');
	});

	it('refuses for a server with no catalog entry behind it', async () => {
		const custom = config({ source: { kind: 'custom', program: '/usr/bin/srv', args: [] } });
		await expect(pickAndInstallAddon(custom, 1)).rejects.toThrow('catalog');
		expect(openFileDialog).not.toHaveBeenCalled();
	});
});
