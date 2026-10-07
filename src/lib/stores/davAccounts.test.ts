import { describe, it, expect, beforeEach } from 'vitest';
import {
	enabledDavAccounts,
	hasEnabledCalendarAccount,
	hasEnabledContactsAccount,
	setDavAccounts
} from '#lib/stores/settings.ts';
import type { DavAccount } from '#lib/ipc/gen/DavAccount.ts';

function server(over: Partial<DavAccount> = {}): DavAccount {
	return {
		id: 's',
		label: 'Fastmail',
		enabled: true,
		address: 'me@fastmail.com',
		username: 'me@fastmail.com',
		password: '',
		passwordRef: 'dav:s',
		calendarUrl: null,
		contactsUrl: null,
		hasCalendars: null,
		hasContacts: null,
		...over
	};
}

function link(over: Partial<DavAccount> = {}): DavAccount {
	return server({
		id: 'l',
		kind: 'ics',
		label: 'Family',
		address: '',
		username: '',
		passwordRef: 'dav:l',
		hasContacts: false,
		...over
	});
}

beforeEach(() => {
	localStorage.clear();
	setDavAccounts([]);
});

describe('enabledDavAccounts', () => {
	it('counts a password kept in the secret store', () => {
		// Since passwords moved to the keychain, `password` is empty and only
		// `passwordRef` says one exists.
		setDavAccounts([server()]);
		expect(enabledDavAccounts().map((a) => a.id)).toEqual(['s']);
		expect(hasEnabledCalendarAccount()).toBe(true);
	});

	it('leaves out a server account missing its address or secret', () => {
		setDavAccounts([
			server({ id: 'a', address: ' ' }),
			server({ id: 'b', passwordRef: undefined })
		]);
		expect(enabledDavAccounts()).toEqual([]);
	});

	it('takes a calendar link with nothing but its link', () => {
		setDavAccounts([link()]);
		expect(enabledDavAccounts().map((a) => a.id)).toEqual(['l']);
		expect(hasEnabledCalendarAccount()).toBe(true);
	});

	it('never offers contact tools for a calendar link', () => {
		setDavAccounts([link({ hasContacts: null })]);
		expect(hasEnabledContactsAccount()).toBe(false);
		setDavAccounts([link(), server()]);
		expect(hasEnabledContactsAccount()).toBe(true);
	});

	it('skips a disabled link', () => {
		setDavAccounts([link({ enabled: false })]);
		expect(enabledDavAccounts()).toEqual([]);
	});
});
