import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { flushSync } from 'svelte';

// The settings as Settings would change them. The mocks read it only when
// called, after this module has run.
const live = $state({ emailAccounts: 0 });
const m = vi.hoisted(() => ({ addCard: vi.fn(async () => null) }));

vi.mock('#lib/stores/settings.ts', () => ({ getLiveSettings: () => live }));
vi.mock('#lib/home/cardTypes.ts', () => ({
	cardTypes: () => [
		{ id: 'jobs', label: 'Jobs', kind: 'live', defaultSize: 'normal' },
		{
			id: 'important_emails',
			label: 'Important emails',
			kind: 'judged',
			defaultSize: 'normal',
			form: {},
			unavailable: () =>
				live.emailAccounts > 0 ? null : 'Add an email account in Settings → Integrations → Email.'
		}
	]
}));
vi.mock('#lib/stores/homeCards.svelte.ts', () => ({ addCard: m.addCard }));
vi.mock('#lib/home/cardJobs.ts', () => ({ createCardJob: vi.fn() }));
vi.mock('#lib/home/fetchedCards.svelte.ts', () => ({ refreshCard: vi.fn() }));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({ getJobs: () => [] }));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({ getJobType: () => undefined }));

import AddCardMenu from './AddCardMenu.svelte';

beforeEach(() => {
	live.emailAccounts = 0;
	m.addCard.mockClear();
});

describe('Add card', () => {
	it('lists a card it can’t add yet, greyed out with what to set up', async () => {
		render(AddCardMenu);
		await fireEvent.click(screen.getByRole('button', { name: 'Add card' }));
		const email = screen.getByRole('menuitem', { name: 'Important emails…' });
		expect(email.getAttribute('aria-disabled')).toBe('true');
		expect(email.getAttribute('title')).toBe(
			'Add an email account in Settings → Integrations → Email.'
		);
		await fireEvent.click(email);
		// Still open: nothing was chosen.
		screen.getByRole('menu');

		const jobs = screen.getByRole('menuitem', { name: 'Jobs' });
		expect(jobs.getAttribute('aria-disabled')).toBe('false');
		await fireEvent.click(jobs);
		expect(m.addCard).toHaveBeenCalledWith('jobs', {}, null, 'normal');
	});

	it('offers it once the account is added, with no restart', async () => {
		render(AddCardMenu);
		await fireEvent.click(screen.getByRole('button', { name: 'Add card' }));
		live.emailAccounts = 1;
		flushSync();
		const email = screen.getByRole('menuitem', { name: 'Important emails…' });
		expect(email.getAttribute('aria-disabled')).toBe('false');
		expect(email.getAttribute('title')).toBeNull();
	});
});
