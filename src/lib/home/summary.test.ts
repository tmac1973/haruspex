import { describe, expect, it } from 'vitest';
import type { Meeting } from '#lib/home/meetings.ts';
import { greeting, summaryFacts, type SummaryInput } from './summary';

const NOW = new Date(2026, 10, 2, 14, 0);

function meeting(summary: string, start: number, end: number, allDay = false): Meeting {
	return {
		summary,
		start: new Date(2026, 10, 2, start).toISOString(),
		end: new Date(2026, 10, 2, end).toISOString(),
		allDay
	} as Meeting;
}

function input(over: Partial<SummaryInput> = {}): SummaryInput {
	return { runs: [], queued: 0, attention: 0, emails: null, meetings: [], ...over };
}

describe('greeting', () => {
	it('follows the hour', () => {
		expect(greeting(new Date(2026, 10, 2, 8))).toBe('Good morning');
		expect(greeting(NOW)).toBe('Good afternoon');
		expect(greeting(new Date(2026, 10, 2, 21))).toBe('Good evening');
		expect(greeting(new Date(2026, 10, 2, 2))).toBe('Good evening');
	});
});

describe('summaryFacts', () => {
	it('says nothing when nothing is going on', () => {
		expect(summaryFacts(input({ emails: 0 }), NOW)).toEqual([]);
	});

	it('names a running job, the queue, sessions and email, each once', () => {
		const facts = summaryFacts(
			input({ runs: [{ status: 'running' }], queued: 2, attention: 1, emails: 3 }),
			NOW
		);
		expect(facts.map((f) => [f.count, f.label, f.target])).toEqual([
			[1, 'job running', 'jobs'],
			[2, 'queued', 'jobs'],
			[1, 'session needs you', 'code'],
			[3, 'important emails', null]
		]);
	});

	it('leaves out a run that has finished', () => {
		expect(summaryFacts(input({ runs: [{ status: 'succeeded' }] }), NOW)).toEqual([]);
	});

	it('says a job is waiting on an answer', () => {
		expect(summaryFacts(input({ runs: [{ status: 'needs_input' }] }), NOW)[0].label).toBe(
			'job needs your answer'
		);
	});

	it('picks the next meeting that has not ended, skipping all-day ones', () => {
		const meetings = [
			meeting('Later', 16, 17),
			meeting('Over', 10, 11),
			meeting('Holiday', 0, 23, true),
			meeting('Design sync', 13, 15)
		];
		expect(summaryFacts(input({ meetings }), NOW)).toEqual([
			{ key: 'meeting', count: null, label: 'Next: Design sync now', target: null }
		]);
		const later = summaryFacts(input({ meetings: [meeting('Later', 16, 17)] }), NOW)[0];
		expect(later.label).toMatch(/^Next: Later at /);
	});
});
