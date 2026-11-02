import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/svelte';

const presets = [
	{
		id: 'gmail',
		label: 'Gmail',
		imap_host: 'imap.gmail.com',
		imap_port: 993,
		imap_tls: 'implicit',
		smtp_host: 'smtp.gmail.com',
		smtp_port: 465,
		smtp_tls: 'implicit',
		requires_2fa: true,
		app_password_url: 'https://example.com/app-passwords'
	}
];

const { invokeRouter } = await vi.hoisted(() => import('#lib/testing/invoke.ts'));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(
		invokeRouter(
			{
				email_list_providers: () => presets,
				mcp_runtimes_available: { node: false, uv: false },
				get_active_model_path: null,
				get_models_dir: null
			},
			// The sections load lists on mount; an array is the shape that keeps
			// their `$derived` chains valid without mocking each one by name.
			() => []
		)
	)
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async () => () => {})
}));

import SettingsPanel from '#lib/components/settings/SettingsPanel.svelte';

/** Click a settings rail item by its visible label. */
function rail(label: string): HTMLElement {
	const found = screen.getAllByRole('button').find((b) => b.textContent?.trim() === label);
	if (!found) throw new Error(`no rail item called ${label}`);
	return found;
}

const settle = () => new Promise((r) => setTimeout(r, 20));

beforeEach(() => {
	localStorage.clear();
});

describe('settings navigation', () => {
	/**
	 * The bug this exists for: the sections edit a working copy held in
	 * `$state`, and handing that back to the store put a Svelte proxy inside
	 * the settings object. `structuredClone` throws `DataCloneError` on a
	 * proxy, so the next time the section mounted its own initialiser threw —
	 * which in a Svelte template aborts the render and leaves the panel stuck
	 * on whichever page it was already showing. Nothing appeared to happen
	 * when you clicked.
	 */
	it('returns to Integrations after an account was added and left unsaved', async () => {
		render(SettingsPanel, { props: { onclose: () => {} } });

		rail('Integrations').click();
		await settle();
		expect(document.body.textContent).toContain('with Allow sending drafts messages');

		screen.getByText('Add email account').click();
		await settle();

		rail('General').click();
		await settle();
		expect(document.body.textContent).not.toContain('with Allow sending drafts messages');

		rail('Integrations').click();
		await settle();
		expect(document.body.textContent).toContain('with Allow sending drafts messages');
	});

	it('returns to Integrations after a calendar account was added', async () => {
		// Same trap, same shape, different section — CalendarSection holds its
		// accounts in `$state` and persists them the same way.
		render(SettingsPanel, { props: { onclose: () => {} } });

		rail('Integrations').click();
		await settle();

		screen.getByText('Add a calendar link').click();
		await settle();

		rail('General').click();
		await settle();
		rail('Integrations').click();
		await settle();

		expect(document.body.textContent).toContain('Calendar & Contacts');
	});

	it('moves between every section without getting stuck', async () => {
		render(SettingsPanel, { props: { onclose: () => {} } });

		for (const [label, marker] of [
			['Inference', 'Inference'],
			['Memory', 'Memory'],
			['Network', 'Network'],
			['Screen', 'Screen capture'],
			['Integrations', 'with Allow sending drafts messages'],
			['MCP servers', 'MCP integrations'],
			['General', 'General']
		] as const) {
			rail(label).click();
			await settle();
			expect(document.body.textContent, `after clicking ${label}`).toContain(marker);
		}
	});

	it('keeps MCP servers out of Integrations', async () => {
		render(SettingsPanel, { props: { onclose: () => {} } });

		rail('Integrations').click();
		await settle();
		expect(document.body.textContent).toContain('Calendar & Contacts');
		expect(document.body.textContent).not.toContain('MCP integrations');

		rail('MCP servers').click();
		await settle();
		expect(document.body.textContent).toContain('MCP integrations');
		expect(document.body.textContent).not.toContain('Calendar & Contacts');
	});

	it('counts MCP servers that need the user on the rail', async () => {
		const { invoke } = await import('@tauri-apps/api/core');
		const { refreshUpdateStatuses } = await import('#lib/stores/mcpUpdate.svelte.ts');
		vi.mocked(invoke).mockImplementationOnce(async () => [
			{
				serverId: 's',
				installedVersion: '1',
				pinnedVersion: '2',
				updateAvailable: true,
				blockedReason: null
			}
		]);
		await refreshUpdateStatuses([
			{
				id: 's',
				label: 'S',
				enabled: true,
				source: { kind: 'catalog', entryId: 'e' },
				secrets: {},
				toolEnabled: {},
				proxyUse: 'auto',
				setupComplete: true,
				addonProjects: []
			}
		]);
		render(SettingsPanel, { props: { onclose: () => {} } });

		// The count sits beside the label without changing the button's name.
		const mcp = screen.getByRole('button', { name: 'MCP servers' });
		expect(mcp.title).toBe('1 need attention');
		expect(mcp.textContent).toContain('1');

		await refreshUpdateStatuses([]);
		await settle();
		expect(rail('MCP servers').title).toBe('');
	});
});
