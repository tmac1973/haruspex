// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
	resultJson: null as string | null,
	picked: 'nb1' as string | null,
	added: [] as { notebookId: string; title: string; source: unknown }[],
	toasts: [] as string[],
	changed: [] as string[][]
}));

vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	getJobRun: vi.fn(async () => ({ result_json: h.resultJson }))
}));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({
	getJobType: (id: string) =>
		id === 'audit'
			? {
					notebookCards: (r: { n: number }) =>
						Array.from({ length: r.n }, (_, i) => ({ kind: 'text', title: `c${i}` }))
				}
			: { notebookCards: undefined }
}));
vi.mock('#lib/notebooks/notebookPicker.svelte.ts', () => ({
	pickNotebook: vi.fn(async () => h.picked)
}));
vi.mock('#lib/notebooks/api.ts', () => ({
	addCard: vi.fn(async (notebookId: string, card: { title: string }, source: unknown) => {
		h.added.push({ notebookId, title: card.title, source });
		return { id: `id-${card.title}` };
	}),
	listNotebooks: vi.fn(async () => [{ id: 'nb1', title: 'Fixes' }])
}));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({
	emitNotebookChanged: (_id: string, ids: string[]) => h.changed.push(ids),
	openNotebook: vi.fn()
}));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({
	showToast: (message: string) => h.toasts.push(message)
}));

import { captureRunResult } from './capture';
import { jobSourceAttr, SOURCE_ATTR } from './source';

function buttonInRun(): HTMLElement {
	const view = document.createElement('div');
	view.setAttribute(SOURCE_ATTR, jobSourceAttr(3, 7, 'Audit'));
	view.innerHTML = '<button></button>';
	return view.querySelector('button')!;
}

const AT = { x: 0, y: 0 };

beforeEach(() => {
	h.resultJson = null;
	h.picked = 'nb1';
	h.added = [];
	h.toasts = [];
	h.changed = [];
});

describe('saving a run result to a notebook', () => {
	it("adds the type's cards in order, from that job run", async () => {
		h.resultJson = JSON.stringify({ n: 2 });
		await captureRunResult({ id: 7, jobType: 'audit' }, AT, buttonInRun());
		expect(h.added).toEqual([
			{ notebookId: 'nb1', title: 'c0', source: { kind: 'job', ref: '3:7', label: 'Audit' } },
			{ notebookId: 'nb1', title: 'c1', source: { kind: 'job', ref: '3:7', label: 'Audit' } }
		]);
		expect(h.changed).toEqual([['id-c0', 'id-c1']]);
		expect(h.toasts).toEqual(['Added to Fixes.']);
	});

	it('says there is nothing to save, without asking, when the run stored no result', async () => {
		await captureRunResult({ id: 7, jobType: 'audit' }, AT, buttonInRun());
		h.resultJson = 'not json';
		await captureRunResult({ id: 7, jobType: 'audit' }, AT, buttonInRun());
		h.resultJson = JSON.stringify({ n: 2 });
		await captureRunResult({ id: 7, jobType: 'research' }, AT, buttonInRun());
		expect(h.added).toEqual([]);
		expect(h.toasts).toEqual(Array(3).fill('This run has nothing to save to a notebook.'));
	});

	it('adds nothing when the picker is closed', async () => {
		h.resultJson = JSON.stringify({ n: 1 });
		h.picked = null;
		await captureRunResult({ id: 7, jobType: 'audit' }, AT, buttonInRun());
		expect(h.added).toEqual([]);
		expect(h.toasts).toEqual([]);
	});
});
