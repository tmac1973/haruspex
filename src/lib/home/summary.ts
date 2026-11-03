/**
 * The band at the top of Home: a greeting and what needs looking at,
 * worked out from what the cards already read.
 */
import type { Meeting } from '#lib/home/meetings.ts';

/** All the band needs of a meeting, which the web client's payload carries too. */
export type MeetingTimes = Pick<Meeting, 'summary' | 'start' | 'end' | 'allDay'>;

export interface SummaryInput {
	/** The job run going now, or null. */
	run: { status: string } | null;
	queued: number;
	/** Open Code sessions waiting on the user. */
	attention: number;
	/** What the Important emails cards show, all together; null without such a card. */
	emails: number | null;
	/** What the Upcoming meetings cards read. */
	meetings: MeetingTimes[];
}

/** One fact in the band; `target` is the tab a click opens. */
export interface SummaryFact {
	key: string;
	count: number | null;
	label: string;
	target: 'jobs' | 'code' | null;
}

export function greeting(now = new Date()): string {
	const hour = now.getHours();
	if (hour < 5 || hour >= 18) return 'Good evening';
	return hour < 12 ? 'Good morning' : 'Good afternoon';
}

function time(at: string): string {
	return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

/** The next meeting that hasn't ended, as "Next: Design sync at 3:30 PM" or "… now". */
function nextMeeting(meetings: MeetingTimes[], now: Date): string | null {
	const next = meetings
		.filter((m) => !m.allDay && Date.parse(m.end) > now.getTime())
		.sort((a, b) => Date.parse(a.start) - Date.parse(b.start))[0];
	if (!next) return null;
	const title = next.summary || '(no title)';
	return Date.parse(next.start) <= now.getTime()
		? `${title} now`
		: `${title} at ${time(next.start)}`;
}

export function summaryFacts(input: SummaryInput, now = new Date()): SummaryFact[] {
	const facts: SummaryFact[] = [];
	if (input.run?.status === 'needs_input') {
		facts.push({ key: 'run', count: 1, label: 'job needs your answer', target: 'jobs' });
	} else if (input.run) {
		facts.push({ key: 'run', count: 1, label: 'job running', target: 'jobs' });
	}
	if (input.queued > 0) {
		facts.push({ key: 'queued', count: input.queued, label: 'queued', target: 'jobs' });
	}
	if (input.attention > 0) {
		const label = input.attention === 1 ? 'session needs you' : 'sessions need you';
		facts.push({ key: 'attention', count: input.attention, label, target: 'code' });
	}
	if (input.emails) {
		const label = input.emails === 1 ? 'important email' : 'important emails';
		facts.push({ key: 'emails', count: input.emails, label, target: null });
	}
	const meeting = nextMeeting(input.meetings, now);
	if (meeting) facts.push({ key: 'meeting', count: null, label: `Next: ${meeting}`, target: null });
	return facts;
}
