/**
 * Calendar tools, over CalDAV.
 *
 * Two tools rather than one. "What's on Thursday" and "when did I last see
 * Sarah" are different questions, and a single tool with an optional query
 * argument gets used for the first and forgotten for the second.
 *
 * Both default their window rather than requiring dates. Making a model compute
 * "next Tuesday" before it can ask a question is a step it gets wrong often
 * enough to matter, and getting it wrong produces a confidently empty answer
 * rather than an error.
 */

import { invoke } from '@tauri-apps/api/core';
import { IPC } from '$lib/ipc/commands';
import type { CalendarQueryResult } from '$lib/ipc/gen/CalendarQueryResult';
import type { CalendarEvent } from '$lib/ipc/gen/CalendarEvent';
import type { DavAccount } from '$lib/ipc/gen/DavAccount';
import { enabledDavAccounts, getSettings } from '$lib/stores/settings';
import { registerTool } from './registry';
import { toolResult, toolError } from './types';

/**
 * Which accounts a call should reach.
 *
 * Mirrors `resolveEmailAccounts`: by UUID, then by label, then by address, and
 * every enabled account when unspecified. That order exists because models
 * identify an account by whatever name the *user* used — "my work calendar" is
 * a label, not an id — and matching only on id would make the natural phrasing
 * fail.
 */
export function resolveDavAccounts(selector?: string): DavAccount[] {
	const all = enabledDavAccounts();
	if (!selector) return all;
	const byId = all.filter((a) => a.id === selector);
	if (byId.length > 0) return byId;
	const needle = selector.trim().toLowerCase();
	const byLabel = all.filter((a) => a.label.trim().toLowerCase() === needle);
	if (byLabel.length > 0) return byLabel;
	return all.filter((a) => a.address.trim().toLowerCase() === needle);
}

/**
 * The zone times should be presented in.
 *
 * Read here rather than in Rust: a Tauri backend's `TZ` is whatever launched
 * the process, which on a desktop is frequently not what the user's clock
 * shows. The webview knows.
 */
function localZone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
	} catch {
		return 'UTC';
	}
}

/** Render one event as a line the model can quote back. */
export function formatEvent(event: CalendarEvent): string {
	const when = event.allDay
		? `${event.start.slice(0, 10)} (all day)`
		: `${event.start} – ${event.end.slice(11, 16)}`;
	const parts = [`${when} · ${event.summary || '(no title)'}`];
	if (event.location) parts.push(`at ${event.location}`);
	if (event.attendees.length) parts.push(`with ${event.attendees.join(', ')}`);
	parts.push(`[${event.accountLabel} / ${event.calendarName}]`);
	if (event.recurring) parts.push('(recurring)');
	if (event.status && event.status.toUpperCase() === 'CANCELLED') parts.push('(CANCELLED)');
	return parts.join(' — ');
}

/**
 * Turn a query result into text.
 *
 * Failures are reported alongside the events rather than instead of them. A
 * user with a working personal calendar and a broken work one should get their
 * personal events; silently returning only those would let the model say "you
 * have nothing on" about a week that is full.
 */
export function formatResult(result: CalendarQueryResult, emptyMessage: string): string {
	const lines: string[] = [];
	if (result.events.length === 0) {
		lines.push(emptyMessage);
	} else {
		lines.push(...result.events.map(formatEvent));
	}
	if (result.problems.length > 0) {
		lines.push('', 'Some calendars could not be read:');
		lines.push(...result.problems.map((p) => `- ${p}`));
	}
	return lines.join('\n');
}

const ACCOUNT_ARG = {
	type: 'string',
	description: 'Which account to query, by name or id. Omit to search every connected account.'
} as const;

const RANGE_ARGS = {
	start: {
		type: 'string',
		description: 'Start of the range, YYYY-MM-DD or a full timestamp. Defaults to a week ago.'
	},
	end: {
		type: 'string',
		description: 'End of the range, YYYY-MM-DD or a full timestamp. Defaults to four weeks ahead.'
	}
} as const;

registerTool({
	category: 'calendar',
	schema: {
		type: 'function',
		function: {
			name: 'calendar_list_events',
			description:
				"List events from the user's calendar. Defaults to a window around today, so dates are optional.",
			parameters: {
				type: 'object',
				properties: {
					...RANGE_ARGS,
					calendar: {
						type: 'string',
						description: 'Restrict to one calendar by name, e.g. "Work". Omit for all of them.'
					},
					account: ACCOUNT_ARG
				}
			}
		}
	},
	displayLabel: (args) => {
		const range = [args.start, args.end].filter(Boolean).join(' to ');
		return range ? `Calendar: ${range}` : 'Calendar';
	},
	execute: async (args) => {
		const accounts = resolveDavAccounts(args.account as string | undefined);
		if (accounts.length === 0) {
			return toolResult(
				toolError('No calendar account matched. The user can add one in Settings → Integrations.')
			);
		}
		try {
			const result = await invoke<CalendarQueryResult>(IPC.dav_list_events, {
				accounts,
				start: args.start ?? null,
				end: args.end ?? null,
				calendar: args.calendar ?? null,
				timeZone: localZone(),
				proxy: getSettings().proxy
			});
			return toolResult(formatResult(result, 'No events in that range.'));
		} catch (e) {
			return toolResult(toolError(`Could not read the calendar: ${String(e)}`));
		}
	}
});

registerTool({
	category: 'calendar',
	schema: {
		type: 'function',
		function: {
			name: 'calendar_search',
			description:
				"Search the user's calendar by text. Matches the title, description, location, organizer and attendees.",
			parameters: {
				type: 'object',
				properties: {
					query: {
						type: 'string',
						description: "Text to look for, e.g. a person's name or a project."
					},
					...RANGE_ARGS,
					account: ACCOUNT_ARG
				},
				required: ['query']
			}
		}
	},
	displayLabel: (args) => `Calendar search: ${String(args.query ?? '')}`,
	execute: async (args) => {
		const query = String(args.query ?? '').trim();
		if (!query) {
			return toolResult(toolError('calendar_search needs something to search for.'));
		}
		const accounts = resolveDavAccounts(args.account as string | undefined);
		if (accounts.length === 0) {
			return toolResult(
				toolError('No calendar account matched. The user can add one in Settings → Integrations.')
			);
		}
		try {
			const result = await invoke<CalendarQueryResult>(IPC.dav_search_events, {
				accounts,
				query,
				start: args.start ?? null,
				end: args.end ?? null,
				timeZone: localZone(),
				proxy: getSettings().proxy
			});
			return toolResult(
				formatResult(
					result,
					`Nothing matching "${query}" in that range. Widen it with start and end if the event is further out.`
				)
			);
		} catch (e) {
			return toolResult(toolError(`Could not search the calendar: ${String(e)}`));
		}
	}
});
