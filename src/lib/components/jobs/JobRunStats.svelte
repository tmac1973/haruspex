<!--
	Per-phase token accounting for a job run — the cumulative answer the live
	context gauge cannot give. A phase is one display step but many independent
	turns (guided planning writes one phase file per turn, plus retries, plus
	fresh-context verification rounds), so the gauge resets between them and
	only ever shows the call in flight. These are the sums across all of them.

	One component for a live run and a finished one: the runner's read-back maps
	persisted rows into the same `StepThinkingStats` shape a running step
	carries, so there is no second implementation to drift.
-->
<script lang="ts">
	import { formatDuration, formatTokens } from '$lib/utils/format';
	import type { StepThinkingStats } from '$lib/agent/jobs/runner.svelte';

	export interface StatsRow {
		label: string;
		/** null when the phase ran no model calls, or was never recorded. */
		stats: StepThinkingStats | null;
	}

	interface Props {
		rows: StatsRow[];
		/** Context window the peak is measured against; null hides that column. */
		contextSize: number | null;
	}

	const { rows, contextSize }: Props = $props();

	const recorded = $derived(rows.filter((r) => r.stats && r.stats.calls > 0));

	const totals = $derived.by(() => {
		if (recorded.length === 0) return null;
		return recorded.reduce(
			(acc, r) => ({
				promptTokens: acc.promptTokens + r.stats!.promptTokens,
				totalTokens: acc.totalTokens + r.stats!.totalTokens,
				reasoningTokens: acc.reasoningTokens + r.stats!.reasoningTokens,
				// Max, not sum: the run's peak is the largest single call
				// anywhere in it, not the phases' peaks added up.
				peakPromptTokens: Math.max(acc.peakPromptTokens, r.stats!.peakPromptTokens),
				calls: acc.calls + r.stats!.calls,
				totalMs: acc.totalMs + r.stats!.totalMs,
				// Estimated if ANY contributing phase estimated — the honest
				// reading of a mixed run.
				reasoningExact: acc.reasoningExact && r.stats!.reasoningExact
			}),
			{
				promptTokens: 0,
				totalTokens: 0,
				reasoningTokens: 0,
				peakPromptTokens: 0,
				calls: 0,
				totalMs: 0,
				reasoningExact: true
			}
		);
	});

	/** "~14.1K (62%)" — the mark is dropped when the backend reported the split. */
	function thinkingCell(stats: {
		reasoningTokens: number;
		totalTokens: number;
		reasoningExact: boolean;
	}): string {
		const mark = stats.reasoningExact ? '' : '~';
		const pct =
			stats.totalTokens > 0 ? Math.round((stats.reasoningTokens / stats.totalTokens) * 100) : 0;
		return `${mark}${formatTokens(stats.reasoningTokens)} (${pct}%)`;
	}

	function peakCell(peak: number): string {
		if (!contextSize || contextSize <= 0) return formatTokens(peak);
		return `${formatTokens(peak)} (${Math.round((peak / contextSize) * 100)}%)`;
	}
</script>

<section class="run-stats">
	<h4>Tokens</h4>

	{#if recorded.length === 0}
		<!-- An old run is not a free run: say it wasn't recorded rather than
		     rendering a table of dashes that reads as "spent nothing". -->
		<p class="hint">Not recorded for this run.</p>
	{:else}
		<div class="table-scroll">
			<table>
				<thead>
					<tr>
						<th class="phase">Phase</th>
						<th>In</th>
						<th>Out</th>
						<th>Thinking</th>
						<th>Calls</th>
						<th>Model time</th>
						<th>Peak ctx</th>
					</tr>
				</thead>
				<tbody>
					{#each rows as row, i (i)}
						<tr>
							<td class="phase">{row.label}</td>
							{#if row.stats && row.stats.calls > 0}
								<td>{formatTokens(row.stats.promptTokens)}</td>
								<td>{formatTokens(row.stats.totalTokens)}</td>
								<td>{thinkingCell(row.stats)}</td>
								<td>{row.stats.calls}</td>
								<td>{formatDuration(row.stats.totalMs)}</td>
								<td>{peakCell(row.stats.peakPromptTokens)}</td>
							{:else}
								<!-- A phase that ran no model calls (a checkpoint waiting
								     on you) spent nothing and records nothing. -->
								<td colspan="6" class="none">—</td>
							{/if}
						</tr>
					{/each}
				</tbody>
				<tfoot>
					<tr>
						<td class="phase">Run total</td>
						<td>{formatTokens(totals!.promptTokens)}</td>
						<td>{formatTokens(totals!.totalTokens)}</td>
						<td>{thinkingCell(totals!)}</td>
						<td>{totals!.calls}</td>
						<td>{formatDuration(totals!.totalMs)}</td>
						<td>{peakCell(totals!.peakPromptTokens)}</td>
					</tr>
				</tfoot>
			</table>
		</div>

		{#if recorded.length < rows.length}
			<p class="hint">
				{recorded.length} of {rows.length} phases recorded — a phase shows no figures when it ran no model
				calls, or when the run ended before it finished.
			</p>
		{/if}

		<p class="hint">
			<strong>In</strong> is tokens processed, not context size: a phase is several independent
			turns and each re-sends its prompt. Locally those re-sends are served from the KV cache rather
			than recomputed; on a metered backend they are billed.
			<strong>Peak ctx</strong> is the largest single prompt — how close the phase came to filling
			the window, which the live gauge can't show because it resets between turns.
			{#if !totals!.reasoningExact}
				Figures marked <code>~</code> are estimates: the backend didn't report how much of its output
				was reasoning, so it's apportioned by character count.
			{/if}
		</p>
	{/if}
</section>

<style>
	.run-stats {
		margin-top: 16px;
		padding-top: 12px;
		border-top: 1px solid var(--border);
	}

	h4 {
		margin: 0 0 8px 0;
		font-size: 0.9rem;
		font-weight: 600;
	}

	.table-scroll {
		overflow-x: auto;
	}

	table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.82rem;
		font-variant-numeric: tabular-nums;
	}

	th,
	td {
		padding: 4px 10px 4px 0;
		text-align: right;
		white-space: nowrap;
	}

	th.phase,
	td.phase {
		text-align: left;
		white-space: normal;
		min-width: 8rem;
	}

	thead th {
		font-weight: 500;
		color: var(--text-secondary);
		border-bottom: 1px solid var(--border);
	}

	tfoot td {
		border-top: 1px solid var(--border);
		font-weight: 600;
	}

	td.none {
		text-align: left;
		color: var(--text-secondary);
	}

	.hint {
		margin: 8px 0 0 0;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}
</style>
