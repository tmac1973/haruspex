import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import type { CatalogEntry } from '#lib/ipc/gen/CatalogEntry.ts';

const invoke = vi.hoisted(() => vi.fn());
vi.mock('@tauri-apps/api/core', () => ({ invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn(async () => () => {}) }));

import McpServerRow from '#lib/components/settings/McpServerRow.svelte';
import { refreshUpdateStatuses } from '#lib/stores/mcpUpdate.svelte.ts';
import { invokeRouter } from '#lib/testing/invoke.ts';

const ID = 'row-1';

function config(over: Partial<McpServerConfig> = {}): McpServerConfig {
	return {
		id: ID,
		label: 'Godot',
		enabled: true,
		source: { kind: 'catalog', entryId: 'godot' },
		secrets: {},
		toolEnabled: {},
		proxyUse: 'auto',
		setupComplete: true,
		addonProjects: [],
		...over
	};
}

const ENTRY: CatalogEntry = {
	id: 'godot',
	name: 'Godot',
	description: 'd',
	homepage: 'h',
	acquisition: { kind: 'pypi', package: 'godot-editor-mcp', version: '2026.10.1', entrypoint: 'g' },
	command: { args: [], env: {} },
	defaultTools: [],
	setup: [
		{
			kind: 'addon',
			label: 'Add the plugin',
			url: 'https://e.test/a.zip',
			sha256: 'x',
			marker: 'project.godot',
			installPath: 'addons/x',
			help: null,
			optional: false
		}
	],
	companion: null,
	provenance: null,
	blockedVersions: []
};

async function withStatus(
	updateAvailable: boolean,
	blockedReason: string | null = null
): Promise<void> {
	invoke.mockImplementation(
		invokeRouter({
			mcp_update_status: [
				{
					serverId: ID,
					installedVersion: '2026.9.2',
					pinnedVersion: '2026.10.1',
					updateAvailable,
					blockedReason
				}
			],
			mcp_existing_dirs: ['/games/one']
		})
	);
	await refreshUpdateStatuses([config()]);
}

beforeEach(() => {
	invoke.mockReset();
	invoke.mockResolvedValue(null);
});

describe('the Update button', () => {
	it('shows only when the catalog pins a newer version', async () => {
		await withStatus(false);
		const { unmount } = render(McpServerRow, {
			props: { config: config(), entry: ENTRY, onchange: () => {}, onremove: () => {} }
		});
		expect(screen.queryByRole('button', { name: 'Update' })).toBeNull();
		unmount();

		await withStatus(true);
		render(McpServerRow, {
			props: { config: config(), entry: ENTRY, onchange: () => {}, onremove: () => {} }
		});
		expect(screen.getByText('Version 2026.10.1 is available.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
	});

	it('drops projects that have gone, then lists the rest before overwriting them', async () => {
		await withStatus(true);
		const onchange = vi.fn();
		render(McpServerRow, {
			props: {
				config: config({ addonProjects: ['/games/one', '/games/gone'] }),
				entry: ENTRY,
				onchange,
				onremove: () => {}
			}
		});
		screen.getByRole('button', { name: 'Update' }).click();
		await vi.waitFor(() => expect(screen.getByText('/games/one')).toBeTruthy());
		await tick();

		expect(screen.queryByText('/games/gone')).toBeNull();
		expect(onchange).toHaveBeenCalledWith(
			expect.objectContaining({ addonProjects: ['/games/one'] })
		);
		// Nothing is downloaded until the user says yes.
		expect(invoke).not.toHaveBeenCalledWith('mcp_update_stage', expect.anything());
	});
});

describe('what the card says', () => {
	const props = () => ({ config: config(), entry: ENTRY, onchange: () => {}, onremove: () => {} });

	it('marks a server with an update next to its name', async () => {
		await withStatus(true);
		render(McpServerRow, { props: props() });
		expect(screen.getByRole('heading', { name: /Godot/ }).textContent).toContain('Update');
	});

	it('shows a blocked version’s reason, offers Update, and will not start it', async () => {
		await withStatus(true, 'Leaks tokens.');
		render(McpServerRow, { props: props() });
		expect(screen.getByText('Stopped for a security problem: Leaks tokens.')).toBeTruthy();
		expect(screen.getByRole('button', { name: 'Update' })).toBeTruthy();
		const start = screen.getByRole('button', { name: 'Start' }) as HTMLButtonElement;
		expect(start.disabled).toBe(true);
		expect(start.title).toBe('Update to start it.');
	});
});
