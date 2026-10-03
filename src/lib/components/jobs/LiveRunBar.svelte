<script lang="ts">
	import { getCurrentRun, getQueueDepth } from '$lib/agent/jobs/runner.svelte';

	// The way back to a live run while you browse other jobs. Shown by the
	// Jobs tab whenever a run is going and its view is hidden.
	let { onopen }: { onopen: () => void } = $props();

	const run = $derived(getCurrentRun());
	const queued = $derived(getQueueDepth());
	const stepText = $derived(
		run && run.steps.length > 0
			? ` · step ${Math.min(run.currentStepIndex + 1, run.steps.length)} of ${run.steps.length}`
			: ''
	);
</script>

{#if run}
	<button type="button" class="live-run-bar" onclick={onopen} title="Show the live run">
		<span class="dot" aria-hidden="true"></span>
		<span class="text">
			Running: <strong>{run.jobName}</strong>{stepText}{queued > 0 ? ` · ${queued} queued` : ''}
		</span>
		<span class="open">Show</span>
	</button>
{/if}

<style>
	.live-run-bar {
		display: flex;
		align-items: center;
		gap: 8px;
		width: 100%;
		padding: 6px 12px;
		border: none;
		border-bottom: 1px solid var(--border);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
		color: var(--text-primary);
		font-size: 0.82rem;
		text-align: left;
		cursor: pointer;
	}

	.live-run-bar:hover {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
	}

	.dot {
		width: 8px;
		height: 8px;
		border-radius: 50%;
		background: var(--accent);
		animation: pulse 1.4s ease-in-out infinite;
		flex-shrink: 0;
	}

	.text {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.open {
		color: var(--accent);
		font-weight: 500;
	}

	@keyframes pulse {
		50% {
			opacity: 0.35;
		}
	}
</style>
