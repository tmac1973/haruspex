import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import CalendarSection from './CalendarSection.svelte';
import { getSettings, setDavAccounts } from '#lib/stores/settings.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

function answer(signIn: () => Promise<unknown>) {
	vi.mocked(invoke).mockImplementation((cmd: string) => {
		switch (cmd) {
			case 'google_sign_in_available':
				return Promise.resolve(true);
			case 'secret_store_kind':
				return Promise.resolve('keychain');
			case 'google_sign_in':
				return signIn();
			case 'dav_discover_collections':
				return Promise.resolve({
					calendars: [{ url: '', name: 'Personal', color: null }],
					addressBooks: [{ url: 'https://x/', name: 'Address Book' }],
					problems: []
				});
			default:
				return Promise.resolve(undefined);
		}
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	localStorage.clear();
	setDavAccounts([]);
});

describe('Sign in with Google', () => {
	it('adds a Google account holding only the secret-store key', async () => {
		answer(() =>
			Promise.resolve({
				email: 'me@gmail.com',
				password: '',
				passwordRef: 'dav:new',
				hasCalendars: true,
				hasContacts: true
			})
		);
		render(CalendarSection);
		await fireEvent.click(await screen.findByText('Sign in with Google'));

		await waitFor(() => expect(getSettings().integrations.dav.accounts).toHaveLength(1));
		const [account] = getSettings().integrations.dav.accounts;
		expect(account.kind).toBe('google');
		expect(account.address).toBe('me@gmail.com');
		expect(account.password).toBe('');
		expect(account.passwordRef).toBe('dav:new');
		expect(account.enabled).toBe(true);
		// The sign-in is followed by a check, which names what it found.
		expect(await screen.findByText('Calendars: Personal')).toBeTruthy();
		expect(screen.getByText('Signed in as me@gmail.com.')).toBeTruthy();
	});

	it('shows why a sign-in failed and adds nothing', async () => {
		answer(() => Promise.reject('Google sign-in was cancelled.'));
		render(CalendarSection);
		await fireEvent.click(await screen.findByText('Sign in with Google'));

		expect(await screen.findByText('Google sign-in was cancelled.')).toBeTruthy();
		expect(getSettings().integrations.dav.accounts).toHaveLength(0);
	});

	it('is not offered by a build without the OAuth client', async () => {
		vi.mocked(invoke).mockImplementation((cmd: string) =>
			Promise.resolve(cmd === 'google_sign_in_available' ? false : undefined)
		);
		render(CalendarSection);
		await screen.findByText('Add a calendar link');
		expect(screen.queryByText('Sign in with Google')).toBeNull();
	});
});
