import { beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync } from 'svelte';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

const m = vi.hoisted(() => ({ notify: vi.fn(async () => {}) }));

/** The newest succeeded run of job 41, as the card would read it. */
const state = $state<{ run: { id: number; result_json: string | null } | null; notify: boolean }>({
	run: null,
	notify: true
});

vi.mock('#lib/notify.ts', () => ({ notify: m.notify }));
vi.mock('#lib/home/cardTypes.ts', () => ({
	getCardType: () => ({
		label: 'Important emails',
		jobType: 'email_digest',
		itemLabel: (i: { subject: string }) => i.subject
	})
}));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({
	getJobType: () => ({ resultSchema: { idField: 'id', fields: {}, max: 8 } })
}));
vi.mock('#lib/home/latestRun.svelte.ts', () => ({
	getLatestRun: () => ({ latest: null, latestSucceeded: state.run })
}));
vi.mock('#lib/stores/homeCards.svelte.ts', () => ({
	loadHomeCards: vi.fn(async () => {}),
	getHomeCards: (): HomeCard[] => [
		{ id: 'c1', card_type: 'important_emails', job_id: 41, notify: state.notify } as HomeCard
	]
}));

import { _resetForTests, startCardWatch } from './cardWatch.svelte';

function result(...subjects: string[]): string {
	return JSON.stringify({ items: subjects.map((s) => ({ id: s, subject: s })) });
}

function finish(id: number, json: string) {
	state.run = { id, result_json: json };
	flushSync();
}

beforeEach(() => {
	_resetForTests();
	state.run = null;
	state.notify = true;
	m.notify.mockClear();
});

describe('card watch', () => {
	it('names what a new run found, after the first result', () => {
		startCardWatch();
		finish(1, result('Invoice'));
		expect(m.notify).not.toHaveBeenCalled();

		finish(2, result('Invoice', 'Offsite', 'Payroll'));
		expect(m.notify).toHaveBeenCalledWith('Important emails', 'Offsite and 1 more');
	});

	it('stays quiet with Notify off, and when nothing is new', () => {
		startCardWatch();
		finish(1, result('Invoice'));
		finish(2, result('Invoice'));
		state.notify = false;
		finish(3, result('Invoice', 'Offsite'));
		expect(m.notify).not.toHaveBeenCalled();
	});
});
