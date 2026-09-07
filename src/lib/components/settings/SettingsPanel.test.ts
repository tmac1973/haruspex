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

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === 'email_list_providers') return presets;
		if (cmd === 'mcp_runtimes_available') return { node: false, uv: false };
		if (cmd === 'mcp_catalog') return [];
		if (cmd === 'mcp_server_status') return [];
		// The sections load lists on mount; an array is the shape that keeps
		// their `$derived` chains valid without mocking each one by name.
		if (cmd === 'get_active_model_path' || cmd === 'get_models_dir') return null;
		return [];
	})
}));
vi.mock('@tauri-apps/api/event', () => ({
	listen: vi.fn(async () => () => {})
}));

import SettingsPanel from '$lib/components/settings/SettingsPanel.svelte';

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
		expect(document.body.textContent).toContain('Email (read-only)');

		screen.getByText('Add email account').click();
		await settle();

		rail('General').click();
		await settle();
		expect(document.body.textContent).not.toContain('Email (read-only)');

		rail('Integrations').click();
		await settle();
		expect(document.body.textContent).toContain('Email (read-only)');
	});

	it('returns to Integrations after a calendar account was added', async () => {
		// Same trap, same shape, different section — CalendarSection holds its
		// accounts in `$state` and persists them the same way.
		render(SettingsPanel, { props: { onclose: () => {} } });

		rail('Integrations').click();
		await settle();

		screen.getByText('Add an account').click();
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
			['Integrations', 'Email (read-only)'],
			['General', 'General']
		] as const) {
			rail(label).click();
			await settle();
			expect(document.body.textContent, `after clicking ${label}`).toContain(marker);
		}
	});
});
