import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

// Side-effect import registers the contact tools in the shared registry.
import '$lib/agent/tools/contacts';
import { formatBrief, formatFull, formatResult } from '$lib/agent/tools/contacts';
import { executeTool, getToolSchemas } from '$lib/agent/tools/registry';
import { setDavAccounts } from '$lib/stores/settings';
import type { DavAccount } from '$lib/ipc/gen/DavAccount';
import type { Contact } from '$lib/ipc/gen/Contact';
import type { ContactQueryResult } from '$lib/ipc/gen/ContactQueryResult';
import type { ToolContext } from '$lib/agent/tools/types';

const ctx: ToolContext = {
	workingDir: null,
	pendingImages: [],
	deepResearch: false,
	shellMode: false,
	codeMode: false,
	codeAutoApprove: false,
	filesWrittenThisTurn: new Set<string>()
};

function account(overrides: Partial<DavAccount> = {}): DavAccount {
	return {
		id: 'dav-1',
		label: 'Fastmail',
		enabled: true,
		address: 'me@example.com',
		username: 'me@example.com',
		password: 'secret',
		calendarUrl: null,
		contactsUrl: null,
		hasCalendars: null,
		hasContacts: null,
		...overrides
	};
}

function contact(overrides: Partial<Contact> = {}): Contact {
	return {
		accountId: 'dav-1',
		accountLabel: 'Fastmail',
		addressBook: 'Contacts',
		uid: 'uid-1',
		fullName: 'Sarah Okonjo',
		firstName: 'Sarah',
		lastName: 'Okonjo',
		emails: [{ kind: 'work', value: 'sarah@example.com' }],
		phones: [{ kind: 'mobile', value: '+1 555 0100' }],
		addresses: [],
		organization: 'Example Ltd',
		title: null,
		note: null,
		birthday: null,
		hasPhoto: false,
		...overrides
	};
}

const result = (over: Partial<ContactQueryResult> = {}): ContactQueryResult => ({
	contacts: [contact()],
	totalMatched: 1,
	problems: [],
	...over
});

beforeEach(() => {
	mocks.invoke.mockReset();
	setDavAccounts([]);
});

describe('the contacts gate', () => {
	it('hides the tools when no account exists', () => {
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).not.toContain('contacts_search');
	});

	it('offers them once an account does', () => {
		setDavAccounts([account()]);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).toContain('contacts_search');
		expect(names).toContain('contacts_get');
	});

	it('hides them for an account whose server serves calendars but not contacts', () => {
		// The whole reason the capability is recorded: offering a tool that can
		// only fail is worse than not offering it.
		setDavAccounts([account({ hasCalendars: true, hasContacts: false })]);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).toContain('calendar_list_events');
		expect(names).not.toContain('contacts_search');
	});

	it('refuses execution when no account serves contacts', async () => {
		setDavAccounts([account({ hasContacts: false })]);
		const out = await executeTool('contacts_search', { query: 'sarah' }, ctx);
		expect(JSON.parse(out.result).error).toContain('Settings → Integrations');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});
});

describe('contacts_search', () => {
	beforeEach(() => setDavAccounts([account()]));

	it('sends the query and every enabled account', async () => {
		mocks.invoke.mockResolvedValue(result());
		await executeTool('contacts_search', { query: 'sarah' }, ctx);

		const [name, args] = mocks.invoke.mock.calls[0];
		expect(name).toBe('dav_search_contacts');
		expect(args.query).toBe('sarah');
		expect(args.accounts).toHaveLength(1);
	});

	it('refuses an empty query rather than listing the whole address book', async () => {
		const out = await executeTool('contacts_search', { query: '  ' }, ctx);
		expect(JSON.parse(out.result).error).toContain('search for');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('renders one line per person, not the whole card', async () => {
		// Twenty full cards crowd out the conversation they were meant to serve.
		mocks.invoke.mockResolvedValue(result());
		const out = await executeTool('contacts_search', { query: 'sarah' }, ctx);
		expect(out.result).toBe('Sarah Okonjo — Example Ltd — sarah@example.com — +1 555 0100');
	});

	it('says the list was cut rather than implying it was complete', async () => {
		mocks.invoke.mockResolvedValue(result({ totalMatched: 60 }));
		const out = await executeTool('contacts_search', { query: 'a' }, ctx);
		expect(out.result).toContain('and 59 more');
	});

	it('reports an unreachable address book instead of an empty one', async () => {
		// "You know nobody there" and "the server did not answer" are different
		// answers, and only one of them is true.
		mocks.invoke.mockResolvedValue(
			result({ contacts: [], totalMatched: 0, problems: ['Work: 401'] })
		);
		const out = await executeTool('contacts_search', { query: 'sarah' }, ctx);
		expect(out.result).toContain('Work: 401');
	});
});

describe('contacts_get', () => {
	beforeEach(() => setDavAccounts([account()]));

	it('passes the identifier through', async () => {
		mocks.invoke.mockResolvedValue(result());
		await executeTool('contacts_get', { identifier: 'sarah@example.com' }, ctx);
		expect(mocks.invoke.mock.calls[0][0]).toBe('dav_get_contact');
		expect(mocks.invoke.mock.calls[0][1].identifier).toBe('sarah@example.com');
	});

	it('points at search when nobody matched', async () => {
		mocks.invoke.mockResolvedValue(result({ contacts: [], totalMatched: 0 }));
		const out = await executeTool('contacts_get', { identifier: 'Nobody' }, ctx);
		expect(out.result).toContain('contacts_search');
	});
});

describe('formatting', () => {
	it('labels each value with the kind the card gave it', () => {
		const text = formatFull(
			contact({
				emails: [
					{ kind: 'work', value: 'work@example.com' },
					{ kind: null, value: 'other@example.com' }
				]
			})
		);
		expect(text).toContain('Email — work: work@example.com');
		// No kind is not the same as "other", so nothing is invented.
		expect(text).toContain('Email — other@example.com');
	});

	it('carries the id so a follow-up can name the same person', () => {
		expect(formatFull(contact())).toContain('id: uid-1');
	});

	it('says a photo exists without carrying its bytes', () => {
		expect(formatFull(contact({ hasPhoto: true }))).toContain('has a photo');
		expect(formatFull(contact({ hasPhoto: false }))).not.toContain('photo');
	});

	it('does not print a heading for a field the card left blank', () => {
		const text = formatFull(contact({ organization: null, note: null, birthday: null }));
		expect(text).not.toContain('Organization');
		expect(text).not.toContain('Note');
	});

	it('names a contact with no name rather than rendering a blank line', () => {
		expect(formatBrief(contact({ fullName: '' }))).toContain('(no name)');
	});

	it('keeps failures alongside whatever did come back', () => {
		const text = formatResult(
			{ contacts: [contact()], totalMatched: 1, problems: ['Work: timed out'] },
			'Nobody.',
			formatBrief
		);
		expect(text).toContain('Sarah Okonjo');
		expect(text).toContain('Work: timed out');
	});
});
