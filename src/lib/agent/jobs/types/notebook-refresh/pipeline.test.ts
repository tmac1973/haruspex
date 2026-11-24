import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { JobRunContext } from '#lib/agent/jobs/types/types.ts';

const api = vi.hoisted(() => ({ getNotebook: vi.fn() }));
vi.mock('#lib/notebooks/api.ts', async (orig) => ({
	...(await orig<typeof import('#lib/notebooks/api.ts')>()),
	...api
}));
vi.mock('#lib/stores/jobRuns.svelte.ts', () => ({
	markRunStarted: vi.fn(),
	markRunStepStarted: vi.fn(),
	markRunStepFinished: vi.fn()
}));

import { REFRESH_TOOLS, runNotebookRefreshPipeline, touchedCards } from './pipeline';
import { validateNotebookRefresh } from './config';

function ctx(over: Partial<JobRunContext> = {}) {
	const turns: Record<string, unknown>[] = [];
	const c = {
		job: { type_config: JSON.stringify({ notebookId: 'n1', instruction: 'update the prices' }) },
		runId: 1,
		patchStep: vi.fn(),
		setCurrentStepIndex: vi.fn(),
		stepAuthored: () => 'Refresh',
		buildStreamCallbacks: () => ({}),
		contextSize: () => 32768,
		setResult: vi.fn(async () => {}),
		finalizeRun: vi.fn(),
		onSettled: vi.fn(),
		runJobTurn: vi.fn(async (t: Record<string, unknown>) => {
			turns.push(t);
			(t.onToolEnd as (c: { name: string }, r: string) => void)?.(
				{ name: 'notebook_table_rows' },
				'Card abcd1234: updated 2 rows; 3 rows now.'
			);
			return { finalText: 'Updated two prices.', rawText: '' };
		}),
		...over
	} as unknown as JobRunContext;
	return { c, turns };
}

const detail = {
	notebook: { id: 'n1', title: 'Speakers', tags: [], deleted_at: null },
	cards: [
		{
			id: 'abcd1234',
			kind: 'text',
			title: 'Notes',
			body: 'hi',
			meta: '{}',
			rows: [],
			row_count: 0
		}
	]
};

describe('notebook refresh', () => {
	beforeEach(() => {
		api.getNotebook.mockReset();
	});

	it('runs one turn with the notebook and web tools, and records what changed', async () => {
		api.getNotebook.mockResolvedValue(detail);
		const { c, turns } = ctx();
		await runNotebookRefreshPipeline(c);
		expect(turns[0].toolAllowlist).toEqual(REFRESH_TOOLS);
		expect(String(turns[0].userMessage)).toContain('Notebook "Speakers"');
		expect(String(turns[0].userMessage)).toContain('Instruction: update the prices');
		expect(vi.mocked(c.finalizeRun).mock.calls[0]).toEqual(['succeeded', null]);
		expect(c.setResult).toHaveBeenCalledWith(
			expect.objectContaining({ notebookId: 'n1', cards: ['abcd1234'] })
		);
		expect(c.finalizeRun).toHaveBeenCalledWith('succeeded', null);
	});

	it('fails cleanly when the notebook is gone', async () => {
		api.getNotebook.mockImplementation(async () => {
			throw new Error('No notebook n1.');
		});
		const { c, turns } = ctx();
		await runNotebookRefreshPipeline(c);
		expect(turns).toHaveLength(0);
		expect(c.finalizeRun).toHaveBeenCalledWith('failed', 'The notebook is in Trash or gone.');
	});

	it('finds the cards the tools changed', () => {
		expect(
			touchedCards(['Card abcd1234: updated 1', 'Changed card ffff0000.', 'card abcd1234'])
		).toEqual(['abcd1234', 'ffff0000']);
	});

	it('checks the settings', () => {
		const exists = (id: string) => id === 'n1';
		expect(
			validateNotebookRefresh({ notebookId: '', instruction: 'x'.repeat(20) }, exists)
		).toMatch(/Pick/);
		expect(
			validateNotebookRefresh({ notebookId: 'n2', instruction: 'x'.repeat(20) }, exists)
		).toMatch(/Trash/);
		expect(validateNotebookRefresh({ notebookId: 'n1', instruction: 'short' }, exists)).toMatch(
			/at least/
		);
		expect(
			validateNotebookRefresh({ notebookId: 'n1', instruction: 'update the prices' }, exists)
		).toBeNull();
	});
});
