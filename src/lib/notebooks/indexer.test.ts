import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
	settings: { notebooks: { semanticSearch: true } as { semanticSearch: boolean } | undefined },
	status: { pending: 0, model_present: true },
	/** What each embedPending call leaves waiting. */
	left: [] as number[],
	embed: vi.fn(),
	changed: null as (() => void) | null,
	off: vi.fn()
}));

vi.mock('#lib/notebooks/api.ts', () => ({
	semanticStatus: vi.fn(async () => m.status),
	embedPending: m.embed
}));
vi.mock('#lib/stores/settings.ts', () => ({ getSettings: () => m.settings }));
vi.mock('#lib/stores/notebooks.svelte.ts', () => ({
	onNotebookChanged: (fn: () => void) => {
		m.changed = fn;
		return m.off;
	}
}));

import * as api from '#lib/notebooks/api.ts';
import {
	getIndexPending,
	indexNow,
	scheduleIndex,
	startNotebookIndexer
} from './indexer.svelte.ts';

beforeEach(() => {
	vi.useFakeTimers();
	m.settings = { notebooks: { semanticSearch: true } };
	m.status = { pending: 0, model_present: true };
	m.left = [];
	m.embed.mockReset();
	m.embed.mockImplementation(async () => m.left.shift() ?? 0);
	vi.mocked(api.semanticStatus).mockClear();
	m.changed = null;
	m.off.mockReset();
});

afterEach(() => {
	vi.useRealTimers();
});

describe('indexNow', () => {
	it('embeds a batch at a time until nothing waits', async () => {
		m.status = { pending: 40, model_present: true };
		m.left = [24, 8, 0];
		const done = indexNow();
		await vi.runAllTimersAsync();
		await done;
		expect(m.embed).toHaveBeenCalledTimes(3);
		expect(m.embed).toHaveBeenCalledWith(16);
		expect(getIndexPending()).toBe(0);
	});

	it('only counts when the model is not downloaded', async () => {
		m.status = { pending: 12, model_present: false };
		await indexNow();
		expect(m.embed).not.toHaveBeenCalled();
		expect(getIndexPending()).toBe(12);
	});

	it('does nothing with semantic search off', async () => {
		m.settings = { notebooks: { semanticSearch: false } };
		await indexNow();
		expect(api.semanticStatus).not.toHaveBeenCalled();
	});

	it('stops between batches when semantic search is turned off', async () => {
		m.status = { pending: 40, model_present: true };
		m.embed.mockImplementation(async () => {
			m.settings = { notebooks: { semanticSearch: false } };
			return 24;
		});
		const done = indexNow();
		await vi.runAllTimersAsync();
		await done;
		expect(m.embed).toHaveBeenCalledTimes(1);
	});

	it('runs one pass at a time', async () => {
		m.status = { pending: 16, model_present: true };
		const first = indexNow();
		await indexNow();
		await vi.runAllTimersAsync();
		await first;
		expect(api.semanticStatus).toHaveBeenCalledTimes(1);
	});

	it('keeps a failure to the log, and can run again after it', async () => {
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		vi.mocked(api.semanticStatus).mockRejectedValueOnce(new Error('db locked'));
		await expect(indexNow()).resolves.toBeUndefined();
		expect(warn).toHaveBeenCalled();
		await indexNow();
		expect(api.semanticStatus).toHaveBeenCalledTimes(2);
		warn.mockRestore();
	});
});

describe('scheduleIndex', () => {
	it('folds a burst of changes into one pass after the last', async () => {
		scheduleIndex(5000);
		await vi.advanceTimersByTimeAsync(3000);
		scheduleIndex(5000);
		await vi.advanceTimersByTimeAsync(4999);
		expect(api.semanticStatus).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);
		expect(api.semanticStatus).toHaveBeenCalledTimes(1);
	});
});

describe('startNotebookIndexer', () => {
	it('indexes at start and after each change, once however often it is started', async () => {
		const stop = startNotebookIndexer();
		const again = startNotebookIndexer();
		await vi.advanceTimersByTimeAsync(5000);
		expect(api.semanticStatus).toHaveBeenCalledTimes(1);

		m.changed!();
		await vi.advanceTimersByTimeAsync(5000);
		expect(api.semanticStatus).toHaveBeenCalledTimes(2);

		again();
		expect(m.off).not.toHaveBeenCalled();
		stop();
		expect(m.off).toHaveBeenCalledTimes(1);
	});

	it('cancels a pass still waiting when it stops', async () => {
		const stop = startNotebookIndexer();
		stop();
		await vi.advanceTimersByTimeAsync(10_000);
		expect(api.semanticStatus).not.toHaveBeenCalled();
	});
});
