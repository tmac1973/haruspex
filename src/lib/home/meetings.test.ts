import { beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';
import { allInvokeArgs, invokeRouter } from '#lib/testing/invoke.ts';

vi.mock('@tauri-apps/api/core', async () =>
	(await import('#lib/testing/invoke.ts')).mockTauriCore()
);

const dav = vi.hoisted(() => ({
	accounts: [
		{ id: 'work', label: 'Work' },
		{ id: 'home', label: 'Home' }
	]
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: { proxy: null },
		enabledDavAccounts: () => dav.accounts
	})
);

import { fetchMeetings, groupOf, joinUrl, type Meeting } from './meetings';

describe('joinUrl', () => {
	it.each([
		'https://meet.google.com/abc-defg-hij',
		'https://us02web.zoom.us/j/123',
		'https://teams.microsoft.com/l/meetup-join/x',
		'https://teams.live.com/meet/9',
		'https://acme.webex.com/meet/pat',
		'https://whereby.com/standup',
		'https://meet.jit.si/Room'
	])('finds %s', (url) => {
		expect(joinUrl(`Call: ${url} (dial-in below)`, null)).toBe(url);
	});

	it('looks in the description when the location has none', () => {
		expect(joinUrl('Room 4', 'Join at https://meet.google.com/x-y-z')).toBe(
			'https://meet.google.com/x-y-z'
		);
	});

	it('ignores plain locations, other sites, and http links', () => {
		expect(joinUrl('Café on Main St', null)).toBeNull();
		expect(joinUrl('https://example.com/agenda', 'http://meet.google.com/a')).toBeNull();
		expect(joinUrl('https://zoom.us.evil.example/j/1', null)).toBeNull();
	});
});

describe('groupOf', () => {
	const now = new Date(2026, 10, 2, 10, 0);
	const at = (h: number, dayOffset = 0): Meeting =>
		({
			start: new Date(2026, 10, 2 + dayOffset, h).toISOString(),
			end: new Date(2026, 10, 2 + dayOffset, h + 1).toISOString()
		}) as Meeting;

	it('sorts by the local day', () => {
		expect(groupOf(at(10, 0), now)).toBe('Now');
		expect(groupOf(at(15, 0), now)).toBe('Later today');
		expect(groupOf(at(9, 1), now)).toBe('Tomorrow');
		expect(groupOf(at(9, 2), now)).toBe('Later');
	});
});

describe('fetchMeetings', () => {
	const now = Date.parse('2026-11-02T10:00:00Z');
	const event = (uid: string, start: string, end: string, status: string | null = null) => ({
		accountId: 'work',
		accountLabel: 'Work',
		calendarName: 'Main',
		uid,
		summary: uid,
		description: null,
		location: null,
		start,
		end,
		timeZone: null,
		allDay: false,
		organizer: null,
		attendees: [],
		recurring: false,
		status
	});

	beforeEach(() => {
		vi.mocked(invoke).mockReset();
	});

	it('asks for the next hours of the chosen accounts and drops cancelled and ended events', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({
				dav_list_events: () => ({
					events: [
						event('later', '2026-11-02T13:00:00Z', '2026-11-02T14:00:00Z'),
						event('ended', '2026-11-02T08:00:00Z', '2026-11-02T09:00:00Z'),
						event('soon', '2026-11-02T11:00:00Z', '2026-11-02T12:00:00Z'),
						event('off', '2026-11-02T12:00:00Z', '2026-11-02T13:00:00Z', 'CANCELLED')
					],
					problems: ['Home: login failed']
				})
			})
		);
		const out = await fetchMeetings({ hours: 6, accountIds: ['work'] }, now);
		const [args] = allInvokeArgs<{ accounts: unknown[]; start: string; end: string }>(
			vi.mocked(invoke)
		);
		expect(args.accounts).toEqual([{ id: 'work', label: 'Work' }]);
		expect(args.start).toBe('2026-11-02T10:00:00.000Z');
		expect(args.end).toBe('2026-11-02T16:00:00.000Z');
		expect(out.events.map((e) => e.uid)).toEqual(['soon', 'later']);
		expect(out.problems).toEqual(['Home: login failed']);
	});

	it('reads every account when none is chosen, and says when there is none', async () => {
		vi.mocked(invoke).mockImplementation(
			invokeRouter({ dav_list_events: { events: [], problems: [] } })
		);
		await fetchMeetings({ hours: 6, accountIds: [] }, now);
		expect(allInvokeArgs<{ accounts: unknown[] }>(vi.mocked(invoke))[0].accounts).toHaveLength(2);

		await expect(fetchMeetings({ hours: 6, accountIds: ['gone'] }, now)).rejects.toThrow(
			/Settings → Integrations/
		);
	});
});
