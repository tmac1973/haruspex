/**
 * Job-run token accounting, as a portable JSON document.
 *
 * The stats card is the only place a run's spend is visible, and it disappears
 * with the run view. Exporting is what makes a run comparable to the next one
 * — a different model, reasoning off, a bigger context — so the export carries
 * the ENVIRONMENT alongside the numbers. A token table without the model that
 * produced it cannot be compared to anything.
 *
 * Pure: the component owns the save dialog, this owns the shape.
 */

import type { RunEnvironment, StepThinkingStats } from './runner.svelte';

export interface StatsExportRow {
	label: string;
	stats: StepThinkingStats | null;
}

export interface StatsExportMeta {
	jobName: string | null;
	jobType: string | null;
	runId: number | null;
	startedAt: number | null;
	finishedAt: number | null;
}

/**
 * Average generation throughput: completion tokens over the model time that
 * produced them. Null when no time was recorded — a rate of 0 would read as
 * "infinitely slow" rather than "unknown".
 *
 * Prompt processing sits inside that window (no backend splits prompt-eval
 * from decode in an OpenAI-shaped response), so this is throughput for the
 * phase as a whole and reads lower than llama.cpp's own tg/s on a phase with
 * large prompts and short answers. Comparable BETWEEN phases of a run, which
 * is what makes a slow phase visible.
 */
export function tokensPerSecond(stats: { totalTokens: number; totalMs: number }): number | null {
	if (stats.totalMs <= 0) return null;
	return stats.totalTokens / (stats.totalMs / 1000);
}

/** Round to one decimal without the float dust (6.5999999 → 6.6). */
function round1(n: number): number {
	return Math.round(n * 10) / 10;
}

function phaseEntry(row: StatsExportRow) {
	const s = row.stats;
	if (!s || s.calls === 0) {
		// Explicitly recorded as not-run rather than omitted: a phase missing
		// from the list reads as a phase that was never planned.
		return { phase: row.label, recorded: false as const };
	}
	const rate = tokensPerSecond(s);
	return {
		phase: row.label,
		recorded: true as const,
		prompt_tokens: s.promptTokens,
		completion_tokens: s.totalTokens,
		reasoning_tokens: s.reasoningTokens,
		reasoning_exact: s.reasoningExact,
		peak_prompt_tokens: s.peakPromptTokens,
		model_calls: s.calls,
		model_ms: s.totalMs,
		reasoning_ms: s.reasoningMs,
		tokens_per_second: rate === null ? null : round1(rate)
	};
}

export function buildStatsExport(args: {
	rows: StatsExportRow[];
	environment: RunEnvironment | null;
	meta: StatsExportMeta;
	contextSize: number | null;
	exportedAt: number;
}): Record<string, unknown> {
	const recorded = args.rows.filter((r) => r.stats && r.stats.calls > 0);
	const totals = recorded.reduce(
		(acc, r) => ({
			prompt_tokens: acc.prompt_tokens + r.stats!.promptTokens,
			completion_tokens: acc.completion_tokens + r.stats!.totalTokens,
			reasoning_tokens: acc.reasoning_tokens + r.stats!.reasoningTokens,
			// Max, not sum — the run's peak is the largest single call in it.
			peak_prompt_tokens: Math.max(acc.peak_prompt_tokens, r.stats!.peakPromptTokens),
			model_calls: acc.model_calls + r.stats!.calls,
			model_ms: acc.model_ms + r.stats!.totalMs,
			reasoning_ms: acc.reasoning_ms + r.stats!.reasoningMs,
			reasoning_exact: acc.reasoning_exact && r.stats!.reasoningExact
		}),
		{
			prompt_tokens: 0,
			completion_tokens: 0,
			reasoning_tokens: 0,
			peak_prompt_tokens: 0,
			model_calls: 0,
			model_ms: 0,
			reasoning_ms: 0,
			reasoning_exact: true
		}
	);
	const rate = tokensPerSecond({ totalTokens: totals.completion_tokens, totalMs: totals.model_ms });
	return {
		schema: 'haruspex.job-run-stats/1',
		exported_at: new Date(args.exportedAt).toISOString(),
		run: {
			id: args.meta.runId,
			job: args.meta.jobName,
			job_type: args.meta.jobType,
			started_at: args.meta.startedAt ? new Date(args.meta.startedAt).toISOString() : null,
			finished_at: args.meta.finishedAt ? new Date(args.meta.finishedAt).toISOString() : null
		},
		environment: {
			model: args.environment?.modelId ?? null,
			thinking: args.environment?.modelThinking ?? null,
			reasoning_effort: args.environment?.modelEffort ?? null,
			context_size: args.environment?.contextSize ?? args.contextSize
		},
		totals: {
			...totals,
			tokens_per_second: rate === null ? null : round1(rate),
			phases_recorded: recorded.length,
			phases_total: args.rows.length
		},
		phases: args.rows.map(phaseEntry)
	};
}

/** `haruspex-stats-<job>-run12-2026-08-19T18-04-31.json`, filesystem-safe. */
export function statsExportFilename(meta: StatsExportMeta, exportedAt: number): string {
	const slug =
		(meta.jobName ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-+|-+$/g, '')
			.slice(0, 40) || 'run';
	const stamp = new Date(exportedAt).toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const run = meta.runId === null ? '' : `-run${meta.runId}`;
	return `haruspex-stats-${slug}${run}-${stamp}.json`;
}
