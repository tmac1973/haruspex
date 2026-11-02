/**
 * Upcoming meetings for Home: the next few hours of the user's calendars,
 * read with the same command the calendar tools use, and no model.
 */
import { invoke } from '@tauri-apps/api/core';
import type { CalendarEvent } from '#lib/ipc/gen/CalendarEvent.ts';
import type { CalendarQueryResult } from '#lib/ipc/gen/CalendarQueryResult.ts';
import { enabledDavAccounts, getSettings } from '#lib/stores/settings.ts';

export interface MeetingsConfig {
	/** How far ahead to look. */
	hours: number;
	/** The calendar accounts to read; empty reads every enabled one. */
	accountIds: string[];
}

export const DEFAULT_MEETING_HOURS = 12;

export interface Meeting {
	uid: string;
	accountId: string;
	summary: string;
	/** RFC 3339, in the user's zone. */
	start: string;
	end: string;
	allDay: boolean;
	location: string | null;
	organizer: string | null;
	attendees: string[];
	/** A video call link from the location or description, when there is one. */
	joinUrl: string | null;
}

export interface MeetingsResult {
	events: Meeting[];
	/** Accounts that could not be read, named. */
	problems: string[];
}

/** Hosts whose links are video calls a Join button can open. */
const JOIN_HOSTS = [
	'meet.google.com',
	'zoom.us',
	'teams.microsoft.com',
	'teams.live.com',
	'webex.com',
	'whereby.com',
	'meet.jit.si'
];

function isJoinHost(host: string): boolean {
	return JOIN_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
}

/** The first https video-call link in the location, then the description. */
export function joinUrl(location: string | null, description: string | null): string | null {
	for (const text of [location, description]) {
		for (const match of text?.matchAll(/https:\/\/[^\s<>"')]+/g) ?? []) {
			try {
				if (isJoinHost(new URL(match[0]).hostname.toLowerCase())) return match[0];
			} catch {
				// Not a URL after all; look at the next one.
			}
		}
	}
	return null;
}

function meetingOf(e: CalendarEvent): Meeting {
	return {
		uid: e.uid,
		accountId: e.accountId,
		summary: e.summary,
		start: e.start,
		end: e.end,
		allDay: e.allDay,
		location: e.location,
		organizer: e.organizer,
		attendees: e.attendees,
		joinUrl: joinUrl(e.location, e.description)
	};
}

function localZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** The next `hours` of events, soonest first, without cancelled ones. */
export async function fetchMeetings(
	config: MeetingsConfig,
	now = Date.now()
): Promise<MeetingsResult> {
	const enabled = enabledDavAccounts();
	const accounts =
		config.accountIds.length > 0
			? enabled.filter((a) => config.accountIds.includes(a.id))
			: enabled;
	if (accounts.length === 0) {
		throw new Error('No calendar account is on. Add one in Settings → Integrations.');
	}
	const result = await invoke<CalendarQueryResult>('dav_list_events', {
		accounts,
		start: new Date(now).toISOString(),
		end: new Date(now + config.hours * 3_600_000).toISOString(),
		calendar: null,
		timeZone: localZone(),
		proxy: getSettings().proxy
	});
	const events = result.events
		.filter((e) => e.status?.toUpperCase() !== 'CANCELLED')
		.filter((e) => Date.parse(e.end) > now)
		.map(meetingOf)
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
	return { events, problems: result.problems };
}

export type MeetingGroup = 'Now' | 'Later today' | 'Tomorrow' | 'Later';

/** Which heading an event sits under, by the user's local day. */
export function groupOf(m: Meeting, now = new Date()): MeetingGroup {
	const start = new Date(m.start);
	if (start.getTime() <= now.getTime() && Date.parse(m.end) > now.getTime()) return 'Now';
	const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
	const days = Math.round((day(start) - day(now)) / 86_400_000);
	if (days <= 0) return 'Later today';
	return days === 1 ? 'Tomorrow' : 'Later';
}
