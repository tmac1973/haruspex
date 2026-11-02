import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

// The mock reads it only when called, after this module has run.
const cardsState = { cards: [] as HomeCard[] };

const m = vi.hoisted(() => ({
	jobs: [] as { id: number; name: string }[],
	runs: {} as Record<number, unknown[]>,
	runWithSteps: {} as Record<number, unknown>,
	recent: [] as unknown[],
	current: null as unknown,
	queue: [] as { jobId: number }[],
	errors: {} as Record<string, string>
}));

vi.mock('#lib/stores/homeCards.svelte.ts', () => ({
	getHomeCards: () => cardsState.cards,
	loadHomeCards: async () => {}
}));
vi.mock('#lib/stores/dbCall.ts', () => ({
	dbQuery: async (o: { cmd: string; args: { jobId?: number } }) =>
		o.cmd === 'db_job_runs_list_recent' ? m.recent : (m.runs[o.args.jobId!] ?? [])
}));
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	getJobRun: async (id: number) => m.runWithSteps[id] ?? null
}));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({ getJobs: () => m.jobs }));
vi.mock('#lib/agent/jobs/runner.svelte.ts', () => ({
	getCurrentRun: () => m.current,
	getPendingQueue: () => m.queue,
	getQueueDepth: () => m.queue.length
}));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({ getJobType: () => ({ background: true }) }));
vi.mock('#lib/home/fetchedCards.svelte.ts', () => ({
	getCardError: (id: string) => m.errors[id] ?? null
}));
vi.mock('#lib/home/cardTypes.ts', () => ({
	getCardType: (id: string) =>
		({
			jobs: { label: 'Jobs' },
			code_sessions: { label: 'Code sessions' },
			pinned_job: { label: 'Pinned job', title: () => 'Morning report' },
			important_emails: { label: 'Important emails' },
			news: { label: 'News' },
			upcoming_meetings: { label: 'Upcoming meetings' },
			weather: { label: 'Weather' }
		})[id]
}));

import { HOME_OUTPUT_MAX, homeCards } from './home.ts';

const card = (over: Partial<HomeCard>): HomeCard => ({
	id: 'k',
	card_type: 'jobs',
	job_id: null,
	position: 0,
	size: 'normal',
	config: '{}',
	notify: false,
	last_result: null,
	updated_at: null,
	created_at: 0,
	...over
});

const run = (over: Record<string, unknown>) => ({
	id: 1,
	job_id: 7,
	status: 'succeeded',
	error: null,
	finished_at: 5000,
	result_json: null,
	...over
});

beforeEach(() => {
	cardsState.cards = [];
	m.jobs = [];
	m.runs = {};
	m.runWithSteps = {};
	m.recent = [];
	m.current = null;
	m.queue = [];
	m.errors = {};
});

async function only(c: HomeCard) {
	cardsState.cards = [c];
	return (await homeCards(new Date('2026-11-02T08:00:00'))).at(0)!;
}

describe('home.cards', () => {
	it('sends the Jobs card the run going now, the queue and recent runs', async () => {
		m.current = {
			jobName: 'Digest',
			jobType: 'email_digest',
			status: 'running',
			steps: [{}, {}],
			currentStepIndex: 0,
			waitingForSlot: true
		};
		m.queue = [{ jobId: 3 }];
		m.recent = [{ job_name: 'News', status: 'failed', finished_at: 9, started_at: 1 }];
		const view = await only(card({ id: 'j' }));
		expect(view).toEqual({
			id: 'j',
			size: 'normal',
			title: 'Jobs',
			payload: {
				type: 'jobs',
				current: { jobName: 'Digest', line: 'Step 1 of 2 · Waiting for chat' },
				queued: 1,
				recent: [{ jobName: 'News', status: 'Failed', at: 9 }]
			}
		});
	});

	it("cuts a pinned job's output and names it by its job", async () => {
		m.jobs = [{ id: 7, name: 'Morning report' }];
		m.runs[7] = [run({})];
		m.runWithSteps[1] = run({ steps: [{ output: 'x'.repeat(HOME_OUTPUT_MAX + 10) }] });
		const view = await only(card({ card_type: 'pinned_job', job_id: 7 }));
		expect(view.title).toBe('Morning report');
		expect(view.payload).toMatchObject({
			type: 'pinned_job',
			exists: true,
			truncated: true,
			updatedAt: 5000
		});
		expect((view.payload as { output: string }).output).toHaveLength(HOME_OUTPUT_MAX);
	});

	it('says a pinned job was deleted', async () => {
		const view = await only(card({ card_type: 'pinned_job', job_id: 7 }));
		expect(view.payload).toMatchObject({ type: 'pinned_job', exists: false, output: null });
	});

	it('keeps the last good emails under a failed run, with only the facts it shows', async () => {
		m.runs[7] = [run({ id: 2, status: 'failed', error: 'IMAP timed out' }), run({})];
		m.runWithSteps[1] = run({
			result_json: JSON.stringify({
				items: [
					{
						id: 'a|1',
						why: 'Money owed',
						source: {
							accountId: 'a',
							messageId: '1',
							from: 'Dana',
							subject: 'Invoice',
							date: '2026-11-01',
							snippet: 'secret body'
						}
					}
				]
			})
		});
		const view = await only(card({ card_type: 'important_emails', job_id: 7 }));
		expect(view.payload).toEqual({
			type: 'important_emails',
			running: false,
			waiting: false,
			queued: false,
			failed: 'IMAP timed out',
			updatedAt: 5000,
			items: [{ from: 'Dana', subject: 'Invoice', date: '2026-11-01', why: 'Money owed' }]
		});
	});

	it('sends news with its links, and null before a first run', async () => {
		m.queue = [{ jobId: 8 }];
		const none = await only(card({ card_type: 'news', job_id: 8 }));
		expect(none.payload).toMatchObject({ type: 'news', items: null, queued: true });

		m.runs[8] = [run({ id: 3 })];
		m.runWithSteps[3] = run({
			result_json: JSON.stringify({
				items: [
					{
						id: 'n',
						summary: 'A rocket went up.',
						source: { title: 'Launch', link: 'https://x/l', source: 'S', published: 4, excerpt: '' }
					}
				]
			})
		});
		const view = await only(card({ card_type: 'news', job_id: 8 }));
		expect((view.payload as { items: unknown[] }).items).toEqual([
			{
				title: 'Launch',
				link: 'https://x/l',
				source: 'S',
				published: 4,
				summary: 'A rocket went up.'
			}
		]);
	});

	it('groups meetings and keeps the fetch error beside the last result', async () => {
		m.errors.mt = 'Calendar offline';
		const view = await only(
			card({
				id: 'mt',
				card_type: 'upcoming_meetings',
				updated_at: 3,
				last_result: JSON.stringify({
					events: [
						{
							summary: 'Standup',
							start: '2026-11-02T09:00:00',
							end: '2026-11-02T09:15:00',
							allDay: false,
							location: null,
							joinUrl: 'https://meet/x'
						}
					],
					problems: []
				})
			})
		);
		expect(view.payload).toMatchObject({
			type: 'upcoming_meetings',
			error: 'Calendar offline',
			updatedAt: 3,
			groups: [{ name: 'Later today', events: [{ summary: 'Standup', joinUrl: 'https://meet/x' }] }]
		});
	});

	it('words the weather in its units', async () => {
		const view = await only(
			card({
				card_type: 'weather',
				config: JSON.stringify({ place: 'Halifax' }),
				last_result: JSON.stringify({
					now: { temp: 4.6, code: 0, wind: 12.2 },
					today: { max: 8, min: 1, rain: 20, code: 0 },
					tomorrow: null,
					units: 'metric'
				})
			})
		);
		expect(view.payload).toMatchObject({
			type: 'weather',
			place: 'Halifax',
			now: { temp: '5°C', wind: '12 km/h' },
			tomorrow: null
		});
		expect((view.payload as { today: string }).today).toMatch(/1–8°C · 20% rain$/);
	});

	it('sends an unknown card by its title only', async () => {
		const view = await only(card({ card_type: 'from_the_future' }));
		expect(view).toMatchObject({ title: 'Unknown card', payload: { type: 'unknown' } });
	});
});
