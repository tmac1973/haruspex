import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
	invoke: vi.fn()
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: mocks.invoke
}));

// Side-effect import registers the calendar tools in the shared registry.
import '$lib/agent/tools/calendar';
import { formatEvent, formatResult, resolveDavAccounts } from '$lib/agent/tools/calendar';
import { executeTool, getToolSchemas } from '$lib/agent/tools/registry';
import { setDavAccounts } from '$lib/stores/settings';
import type { DavAccount } from '$lib/ipc/gen/DavAccount';
import type { CalendarEvent } from '$lib/ipc/gen/CalendarEvent';
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
		label: 'Work',
		enabled: true,
		address: 'me@example.com',
		username: 'me@example.com',
		password: 'secret',
		calendarUrl: null,
		contactsUrl: null,
		...overrides
	};
}

function event(overrides: Partial<CalendarEvent> = {}): CalendarEvent {
	return {
		accountId: 'dav-1',
		accountLabel: 'Work',
		calendarName: 'Team',
		uid: 'evt-1',
		summary: 'Quarterly review',
		description: null,
		location: null,
		start: '2026-09-07T14:00:00+00:00',
		end: '2026-09-07T15:00:00+00:00',
		timeZone: null,
		allDay: false,
		organizer: null,
		attendees: [],
		status: null,
		recurring: false,
		...overrides
	};
}

beforeEach(() => {
	mocks.invoke.mockReset();
	setDavAccounts([]);
});

describe('resolveDavAccounts', () => {
	it('returns every enabled account when nothing is named', () => {
		const work = account({ id: 'dav-1', label: 'Work' });
		const home = account({ id: 'dav-2', label: 'Home' });
		setDavAccounts([work, home, account({ id: 'dav-3', enabled: false })]);

		expect(resolveDavAccounts().map((a) => a.id)).toEqual(['dav-1', 'dav-2']);
	});

	it('skips an account that could not authenticate anyway', () => {
		// Fanning out to an account with no password buys a guaranteed failure.
		setDavAccounts([account({ id: 'dav-1' }), account({ id: 'dav-2', password: '' })]);

		expect(resolveDavAccounts().map((a) => a.id)).toEqual(['dav-1']);
	});

	it('matches the label the user would have said, not just the id', () => {
		const work = account({ id: 'dav-1', label: 'Work' });
		setDavAccounts([work, account({ id: 'dav-2', label: 'Home' })]);

		expect(resolveDavAccounts('  wOrK ')).toEqual([work]);
		expect(resolveDavAccounts('dav-1')).toEqual([work]);
		expect(resolveDavAccounts('me@example.com').length).toBe(2);
	});

	it('returns nothing for a selector that matches nothing', () => {
		// Better than silently querying every calendar under a name the user
		// gave to mean one of them.
		setDavAccounts([account()]);
		expect(resolveDavAccounts('School')).toEqual([]);
	});
});

describe('calendar_list_events', () => {
	it('errors without touching the backend when no account is set up', async () => {
		const out = await executeTool('calendar_list_events', {}, ctx);
		expect(JSON.parse(out.result).error).toContain('Settings → Integrations');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('sends every enabled account in one call, with the window left open', async () => {
		// The window defaults in Rust: a model made to compute "next Tuesday"
		// before it can ask gets it wrong and reports an empty week.
		const work = account({ id: 'dav-1' });
		const home = account({ id: 'dav-2', label: 'Home' });
		setDavAccounts([work, home]);
		mocks.invoke.mockResolvedValue({ events: [], problems: [] });

		await executeTool('calendar_list_events', {}, ctx);

		expect(mocks.invoke).toHaveBeenCalledTimes(1);
		const [name, args] = mocks.invoke.mock.calls[0];
		expect(name).toBe('dav_list_events');
		expect(args.accounts).toEqual([work, home]);
		expect(args).toMatchObject({ start: null, end: null, calendar: null });
		expect(typeof args.timeZone).toBe('string');
	});

	it('passes a named calendar and window through', async () => {
		setDavAccounts([account()]);
		mocks.invoke.mockResolvedValue({ events: [], problems: [] });

		await executeTool(
			'calendar_list_events',
			{ start: '2026-09-07', end: '2026-09-08', calendar: 'Work' },
			ctx
		);

		expect(mocks.invoke.mock.calls[0][1]).toMatchObject({
			start: '2026-09-07',
			end: '2026-09-08',
			calendar: 'Work'
		});
	});

	it('reports a backend failure rather than an empty calendar', async () => {
		// "You have nothing on" is a worse answer than "the server refused".
		setDavAccounts([account()]);
		mocks.invoke.mockRejectedValue('401 Unauthorized');

		const out = await executeTool('calendar_list_events', {}, ctx);
		expect(JSON.parse(out.result).error).toContain('401 Unauthorized');
	});
});

describe('calendar_search', () => {
	it('refuses an empty query instead of listing the whole window', async () => {
		setDavAccounts([account()]);
		const out = await executeTool('calendar_search', { query: '   ' }, ctx);
		expect(JSON.parse(out.result).error).toContain('search for');
		expect(mocks.invoke).not.toHaveBeenCalled();
	});

	it('suggests widening the window when nothing matched', async () => {
		setDavAccounts([account()]);
		mocks.invoke.mockResolvedValue({ events: [], problems: [] });

		const out = await executeTool('calendar_search', { query: 'dentist' }, ctx);
		expect(out.result).toContain('start and end');
	});
});

describe('formatting', () => {
	it('names the account and calendar so the model can say where it came from', () => {
		expect(formatEvent(event())).toContain('[Work / Team]');
	});

	it('renders an all-day event as a date, not a midnight timestamp', () => {
		const line = formatEvent(event({ allDay: true, start: '2026-09-07T00:00:00+00:00' }));
		expect(line).toContain('2026-09-07 (all day)');
		expect(line).not.toContain('00:00:00');
	});

	it('flags a cancelled event, which a bare title would not', () => {
		expect(formatEvent(event({ status: 'CANCELLED' }))).toContain('(CANCELLED)');
	});

	it('keeps events and failures together', () => {
		// A working personal calendar and a broken work one should not read as
		// a free week.
		const text = formatResult(
			{ events: [event()], problems: ['Work: 401 Unauthorized'] },
			'No events in that range.'
		);
		expect(text).toContain('Quarterly review');
		expect(text).toContain('Work: 401 Unauthorized');
	});

	it('still surfaces failures when nothing came back at all', () => {
		const text = formatResult({ events: [], problems: ['Work: timed out'] }, 'No events.');
		expect(text).toContain('No events.');
		expect(text).toContain('Work: timed out');
	});
});

describe('tool visibility', () => {
	it('hides the calendar tools until an account exists', () => {
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).not.toContain('calendar_list_events');
	});

	it('offers them once one does', () => {
		setDavAccounts([account()]);
		const names = getToolSchemas({ hasWorkingDir: false }).map((s) => s.function.name);
		expect(names).toContain('calendar_list_events');
		expect(names).toContain('calendar_search');
	});
});
