import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

const m = vi.hoisted(() => ({
	cards: [] as HomeCard[],
	jobs: [] as { id: number; name: string; job_type: string }[],
	createJob: vi.fn<(input: Record<string, unknown>) => Promise<number | null>>(async () => 41),
	addCard: vi.fn(async (type: string, _config: unknown, jobId: number | null) => ({
		id: 'new',
		card_type: type,
		job_id: jobId
	}))
}));

vi.mock('#lib/home/cardTypes.ts', () => ({
	getCardType: (id: string) =>
		({
			digest: { id: 'digest', label: 'Digest', jobType: 'research', defaultSize: 'wide' },
			jobs: { id: 'jobs', label: 'Jobs', defaultSize: 'normal' },
			pinned_job: { id: 'pinned_job', label: 'Pinned job', defaultSize: 'normal' }
		})[id]
}));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({
	getJobType: (id: string) =>
		id === 'research'
			? {
					id,
					configDefaults: () => ({ hours: 24, rule: '' }),
					configToJson: (c: Record<string, unknown>) => JSON.stringify(c)
				}
			: undefined
}));
vi.mock('#lib/stores/jobs.svelte.ts', async (importOriginal) => ({
	...(await importOriginal<typeof import('#lib/stores/jobs.svelte.ts')>()),
	createJob: m.createJob,
	getJobs: () => m.jobs
}));
vi.mock('#lib/stores/homeCards.svelte.ts', () => ({
	addCard: m.addCard,
	getHomeCards: () => m.cards,
	cardUsesExistingJob: (c: HomeCard) => c.config === '{"existingJob":true}'
}));

import { addCardForJob, createCardJob, existingJobsFor, ownedJobIds, ownsJob } from './cardJobs';

function card(id: string, cardType: string, jobId: number | null, config = '{}'): HomeCard {
	return { id, card_type: cardType, job_id: jobId, config } as HomeCard;
}

beforeEach(() => {
	m.cards = [];
	m.createJob.mockClear();
	m.addCard.mockClear();
});

describe('createCardJob', () => {
	it('makes the job due now with the form’s settings, then adds its card', async () => {
		const before = Date.now();
		const added = await createCardJob(
			'digest',
			{ rule: 'From my manager' },
			{
				kind: 'interval',
				minutes: 30
			}
		);

		const input = m.createJob.mock.calls[0][0];
		expect(input).toMatchObject({
			name: 'Digest',
			job_type: 'research',
			schedule_kind: 'interval',
			schedule_config: '{"minutes":30}',
			type_config: '{"hours":24,"rule":"From my manager"}'
		});
		expect(input.next_due_at).toBeGreaterThanOrEqual(before);
		expect(m.addCard).toHaveBeenCalledWith('digest', {}, 41, 'wide');
		expect(added?.job_id).toBe(41);
	});

	it('adds no card when the job could not be made, or the type has no job', async () => {
		m.createJob.mockResolvedValueOnce(null);
		expect(await createCardJob('digest', {}, { kind: 'manual' })).toBeNull();
		expect(await createCardJob('jobs', {}, { kind: 'manual' })).toBeNull();
		expect(m.addCard).not.toHaveBeenCalled();
	});
});

describe('ownedJobIds', () => {
	it('lists the jobs cards made, not pinned jobs', () => {
		m.cards = [card('a', 'digest', 41), card('b', 'pinned_job', 7), card('c', 'digest', null)];
		expect([...ownedJobIds()]).toEqual([41]);
	});

	it('leaves out a job the card was given', () => {
		const given = card('a', 'digest', 9, '{"existingJob":true}');
		m.cards = [given, card('b', 'digest', 41)];
		expect(ownsJob(given)).toBe(false);
		expect([...ownedJobIds()]).toEqual([41]);
	});
});

describe('existingJobsFor', () => {
	it('offers the user’s jobs of the card’s job type, not another card’s own job', () => {
		m.jobs = [
			{ id: 41, name: 'Digest', job_type: 'research' },
			{ id: 9, name: 'My research', job_type: 'research' },
			{ id: 5, name: 'Report', job_type: 'prompt' }
		];
		m.cards = [card('a', 'digest', 41)];
		expect(existingJobsFor('digest').map((j) => j.id)).toEqual([9]);
		expect(existingJobsFor('jobs')).toEqual([]);
	});

	it('adds a card that is marked as showing an existing job', async () => {
		await addCardForJob('digest', 9);
		expect(m.addCard).toHaveBeenCalledWith('digest', { existingJob: true }, 9, 'wide');
	});
});
