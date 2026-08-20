import { describe, it, expect } from 'vitest';
import { buildStatsExport, statsExportFilename, tokensPerSecond } from './statsExport';
import type { StepThinkingStats } from './runner.svelte';

function stats(over: Partial<StepThinkingStats> = {}): StepThinkingStats {
	return {
		reasoningMs: 600,
		totalMs: 1000,
		reasoningTokens: 60,
		totalTokens: 100,
		promptTokens: 4000,
		peakPromptTokens: 4000,
		reasoningExact: true,
		calls: 1,
		...over
	};
}

const meta = {
	jobName: 'Hangman test',
	jobType: 'guided_planning',
	runId: 12,
	startedAt: Date.UTC(2026, 7, 19, 18, 4, 31),
	finishedAt: Date.UTC(2026, 7, 19, 18, 40, 0)
};

const environment = {
	modelId: 'Qwen3.6-35B-A3B-UD-Q8_K_XL',
	modelThinking: true,
	modelEffort: 'high',
	contextSize: 32768
};

describe('tokensPerSecond', () => {
	it('is completion tokens over model seconds', () => {
		expect(tokensPerSecond({ totalTokens: 300, totalMs: 60000 })).toBe(5);
	});

	it('is null — not zero — when no time was recorded', () => {
		// 0 would render as "infinitely slow"; the honest answer is unknown.
		expect(tokensPerSecond({ totalTokens: 100, totalMs: 0 })).toBeNull();
	});
});

describe('buildStatsExport', () => {
	const doc = buildStatsExport({
		rows: [
			{ label: 'Overview', stats: stats({ totalTokens: 100, totalMs: 1000 }) },
			{ label: 'Planning', stats: stats({ totalTokens: 300, totalMs: 60000, calls: 4 }) },
			{ label: 'Approval', stats: null }
		],
		environment,
		meta,
		contextSize: 32768,
		exportedAt: Date.UTC(2026, 7, 19, 19, 0, 0)
	});

	/**
	 * The environment is the point of the export: a token table without the
	 * model that produced it cannot be compared to the next run's.
	 */
	it('carries the model, reasoning settings and context window', () => {
		expect(doc.environment).toEqual({
			model: 'Qwen3.6-35B-A3B-UD-Q8_K_XL',
			thinking: true,
			reasoning_effort: 'high',
			context_size: 32768
		});
	});

	it('sums tokens and takes the max of the peaks', () => {
		const totals = doc.totals as Record<string, number>;
		expect(totals.prompt_tokens).toBe(8000);
		expect(totals.completion_tokens).toBe(400);
		expect(totals.peak_prompt_tokens).toBe(4000);
		expect(totals.model_calls).toBe(5);
	});

	it('reports the aggregate rate, not the mean of the phase rates', () => {
		// 400 tokens / 61s = 6.6, not (100 + 5) / 2.
		expect((doc.totals as Record<string, number>).tokens_per_second).toBe(6.6);
	});

	it('keeps an unrecorded phase in the list, marked as such', () => {
		const phases = doc.phases as Array<Record<string, unknown>>;
		expect(phases).toHaveLength(3);
		// Dropping it would read as a phase that was never planned.
		expect(phases[2]).toEqual({ phase: 'Approval', recorded: false });
		expect((doc.totals as Record<string, number>).phases_recorded).toBe(2);
	});

	it('stamps ISO times so an export is readable without the app', () => {
		expect(doc.exported_at).toBe('2026-08-19T19:00:00.000Z');
		expect((doc.run as Record<string, unknown>).started_at).toBe('2026-08-19T18:04:31.000Z');
	});

	it('falls back to the card context size when the run recorded none', () => {
		const older = buildStatsExport({
			rows: [{ label: 'Overview', stats: stats() }],
			environment: null,
			meta,
			contextSize: 8192,
			exportedAt: 0
		});
		expect((older.environment as Record<string, unknown>).model).toBeNull();
		expect((older.environment as Record<string, unknown>).context_size).toBe(8192);
	});

	it('marks the reasoning split estimated when any phase estimated', () => {
		const mixed = buildStatsExport({
			rows: [
				{ label: 'A', stats: stats({ reasoningExact: true }) },
				{ label: 'B', stats: stats({ reasoningExact: false }) }
			],
			environment,
			meta,
			contextSize: null,
			exportedAt: 0
		});
		expect((mixed.totals as Record<string, boolean>).reasoning_exact).toBe(false);
	});
});

describe('statsExportFilename', () => {
	it('is filesystem-safe and identifies the run', () => {
		expect(statsExportFilename(meta, Date.UTC(2026, 7, 19, 19, 0, 0))).toBe(
			'haruspex-stats-hangman-test-run12-2026-08-19T19-00-00.json'
		);
	});

	it('degrades without a job name or run id', () => {
		expect(statsExportFilename({ ...meta, jobName: null, runId: null }, 0)).toBe(
			'haruspex-stats-run-1970-01-01T00-00-00.json'
		);
	});
});
