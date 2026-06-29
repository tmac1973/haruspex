<script lang="ts">
	/**
	 * Presentational chrome for a single job-run step: the bordered card,
	 * the "Step N" label, and the status pill. The step body (prompt,
	 * output, errors, search steps, …) is passed as children and therefore
	 * styled by the parent — this component owns only the shared card frame
	 * and the status-label mapping that JobRunView (live) and JobRunDetail
	 * (persisted) would otherwise each duplicate.
	 */
	import type { Snippet } from 'svelte';

	// Superset of the live-runner `StepStatus` and the persisted
	// `JobRunStepStatus` — both are subsets of this union.
	type StepCardStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'cancelled';

	interface Props {
		stepNumber: number;
		status: StepCardStatus;
		/** Optional stage name shown after "Step N" (e.g. guided-planning stages). */
		title?: string;
		/** Optional extra content rendered inline after the status pill (e.g. a badge). */
		headExtra?: Snippet;
		children: Snippet;
	}

	const { stepNumber, status, title, headExtra, children }: Props = $props();

	function stepStatusLabel(s: StepCardStatus): string {
		switch (s) {
			case 'pending':
				return 'Pending';
			case 'running':
				return 'Running';
			case 'succeeded':
				return 'Done';
			case 'failed':
				return 'Failed';
			case 'skipped':
				return 'Skipped';
			case 'cancelled':
				return 'Cancelled';
		}
	}
</script>

<div class="step" data-status={status}>
	<div class="step-head">
		<span class="step-num">Step {stepNumber}</span>
		{#if title}<span class="step-title">{title}</span>{/if}
		<span class="status-pill status-{status}">{stepStatusLabel(status)}</span>
		{@render headExtra?.()}
	</div>
	{@render children()}
</div>

<style>
	.step {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		padding: 10px 12px;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.step[data-status='pending'] {
		opacity: 0.55;
	}

	.step-head {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.step-num {
		font-size: 0.74rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--text-secondary);
	}

	.step-title {
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-primary);
	}
</style>
