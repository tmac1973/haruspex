import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';

const m = vi.hoisted(() => ({ jobs: {} as Record<number, string> }));

vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({
			integrations: {
				email: {
					accounts: [
						{
							id: 'home',
							label: 'Home',
							sendEnabled: true,
							emailAddress: 'me@home.example',
							provider: 'icloud'
						},
						{
							id: 'gm',
							label: 'Gmail',
							sendEnabled: true,
							emailAddress: 'me@gmail.com',
							provider: 'gmail'
						},
						{
							id: 'ro',
							label: 'Read only',
							sendEnabled: false,
							emailAddress: 'ro@x.example',
							provider: 'gmail'
						}
					]
				}
			}
		})
	})
);
vi.mock('./accountJobs.svelte.ts', async (orig) => {
	const real = await orig<typeof import('./accountJobs.svelte.ts')>();
	return {
		...real,
		loadEmailResearchAccounts: async () => m.jobs,
		accountTakenBy: (id: string, except?: number) => real.accountTakenBy(id, except, m.jobs)
	};
});

import Editor from './Editor.svelte';
import { emailResearchDefaults } from './config';

function option(label: RegExp): HTMLOptionElement {
	return screen.getByRole('option', { name: label }) as HTMLOptionElement;
}

beforeEach(() => {
	m.jobs = {};
});

describe('Research by email editor', () => {
	it('offers only accounts that can send and have no job yet', () => {
		m.jobs = { 4: 'gm' };
		render(Editor, { config: { ...emailResearchDefaults() } });
		expect(option(/^Home/).disabled).toBe(false);
		expect(option(/^Read only/).disabled).toBe(true);
		expect(option(/^Read only/).title).toMatch(/Allow sending is off/);
		expect(option(/^Gmail/).disabled).toBe(true);
		expect(option(/^Gmail/).title).toBe('Already has a job.');
	});

	it('still offers the account of the job being edited', () => {
		m.jobs = { 4: 'gm' };
		render(Editor, { config: { ...emailResearchDefaults(), accountId: 'gm' }, jobId: 4 });
		expect(option(/^Gmail/).disabled).toBe(false);
	});

	it('warns about a short phrase and a provider that may not keep a Sent copy', () => {
		render(Editor, { config: { ...emailResearchDefaults(), accountId: 'home', phrase: 'ask' } });
		screen.getByText('Short phrases are easy to guess.');
		screen.getByText('Your mail app must save sent mail to Sent.');
	});

	it('shows no warning for a long phrase on Gmail', () => {
		render(Editor, {
			config: { ...emailResearchDefaults(), accountId: 'gm', phrase: 'ask haruspex please' }
		});
		expect(screen.queryByText('Short phrases are easy to guess.')).toBeNull();
		expect(screen.queryByText('Your mail app must save sent mail to Sent.')).toBeNull();
	});

	it('saves No limit as a null daily limit', async () => {
		const config: Record<string, unknown> = { ...emailResearchDefaults() };
		render(Editor, { config });
		expect(config.dailyLimit).toBe(10);
		await fireEvent.click(screen.getByLabelText('No limit'));
		expect(config.dailyLimit).toBeNull();
	});
});
