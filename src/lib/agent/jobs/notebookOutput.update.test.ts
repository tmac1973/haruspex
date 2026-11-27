import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { NotebookStep } from './notebookOutput';

const h = vi.hoisted(() => ({
	notebook: null as null | { deleted_at: number | null },
	calls: [] as string[],
	conflicts: 0,
	saved: null as null | Record<string, unknown>
}));

vi.mock('#lib/notebooks/api.ts', () => ({
	getNotebook: vi.fn(async (id: string) => {
		if (!h.notebook) throw new Error('not found');
		return { notebook: { id, title: 'Audit', ...h.notebook }, cards: [] };
	}),
	createNotebook: vi.fn(async (title: string) => {
		h.calls.push(`create ${title}`);
		return { id: 'nb-new', title };
	}),
	addCard: vi.fn(async (id: string, card: { title: string }) => {
		h.calls.push(`add ${id} ${card.title}`);
		return { id: 'c' };
	}),
	updateCard: vi.fn(async (id: string) => {
		if (h.conflicts > 0) {
			h.conflicts--;
			throw 'conflict';
		}
		h.calls.push(`body ${id}`);
		return { id, version: 5 };
	}),
	getRows: vi.fn(),
	setColumns: vi.fn(),
	applyRows: vi.fn(),
	isConflict: (e: unknown) => e === 'conflict'
}));
vi.mock('#lib/stores/jobs.svelte.ts', () => ({
	getJob: vi.fn(async () => ({
		id: 1,
		name: 'Audit',
		type_config: JSON.stringify({ num_runs: 3, notebook_output: 'one' })
	})),
	updateJob: vi.fn(async (_id: number, input: { type_config: string }) => {
		h.saved = JSON.parse(input.type_config);
		return true;
	})
}));

import { updateJobNotebook, type NotebookUpdate } from './notebookOutput';

const update: NotebookUpdate = (cards) =>
	cards.length === 0
		? [
				{
					op: 'add',
					card: { kind: 'text', title: 'Audit summary', body: '', meta: '{}', rows: null }
				}
			]
		: [];

function input(typeConfig: object, up: NotebookUpdate = update) {
	return {
		jobId: 1,
		jobName: 'Audit',
		runId: 9,
		typeConfig: JSON.stringify(typeConfig),
		result: {},
		update: up,
		finishedAt: new Date()
	};
}

beforeEach(() => {
	h.notebook = null;
	h.calls = [];
	h.conflicts = 0;
	h.saved = null;
});

describe('updateJobNotebook', () => {
	it('makes the notebook on the first run and keeps its id on the job', async () => {
		const out = await updateJobNotebook(input({ notebook_output: 'one' }));
		expect(out).toMatchObject({ created: true, notebook: { id: 'nb-new' } });
		expect(h.calls).toEqual(['create Audit', 'add nb-new Audit summary']);
		expect(h.saved).toEqual({ num_runs: 3, notebook_output: 'one', notebook_output_id: 'nb-new' });
	});

	it('updates the notebook the job keeps', async () => {
		h.notebook = { deleted_at: null };
		const steps: NotebookStep[] = [{ op: 'body', cardId: 'c1', version: 4, body: 'x' }];
		const out = await updateJobNotebook(input({ notebook_output_id: 'nb1' }, () => steps));
		expect(out).toMatchObject({ created: false, notebook: { id: 'nb1' } });
		expect(h.calls).toEqual(['body c1']);
		expect(h.saved).toBeNull();
	});

	it('makes a new one when the kept notebook is in Trash or gone', async () => {
		h.notebook = { deleted_at: 123 };
		const out = await updateJobNotebook(input({ notebook_output_id: 'nb1' }));
		expect(out?.created).toBe(true);
		expect(h.saved?.notebook_output_id).toBe('nb-new');
	});

	it('reads again and tries once more when a card changed meanwhile', async () => {
		h.notebook = { deleted_at: null };
		h.conflicts = 1;
		const steps: NotebookStep[] = [{ op: 'body', cardId: 'c1', version: 4, body: 'x' }];
		await updateJobNotebook(input({ notebook_output_id: 'nb1' }, () => steps));
		expect(h.calls).toEqual(['body c1']);

		h.conflicts = 2;
		await expect(updateJobNotebook(input({ notebook_output_id: 'nb1' }, () => steps))).rejects.toBe(
			'conflict'
		);
	});
});
