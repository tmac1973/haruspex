<script lang="ts">
	import { getContextUsage, getContextPercentage } from '$lib/stores/context.svelte';

	const usage = $derived(getContextUsage());
	const percent = $derived(getContextPercentage());
	const visible = $derived(usage.promptTokens > 0 && usage.contextSize > 0);

	function formatTokens(n: number): string {
		if (n >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'K';
		return n.toString();
	}

	function barColor(pct: number): string {
		if (pct >= 80) return 'var(--error-text)';
		if (pct >= 60) return '#f59e0b';
		return 'var(--accent)';
	}
</script>

{#if visible}
	<div
		class="context-indicator"
		title={`Prompt: ${usage.promptTokens.toLocaleString()} tokens | Context: ${usage.contextSize.toLocaleString()} tokens (${percent.toFixed(1)}%)`}
	>
		<span class="context-label">
			{formatTokens(usage.promptTokens)} / {formatTokens(usage.contextSize)}
		</span>
		<div class="context-bar">
			<div
				class="context-fill"
				style="width: {Math.min(percent, 100)}%; background: {barColor(percent)}"
			></div>
		</div>
	</div>
{/if}

<style>
	.context-indicator {
		display: flex;
		align-items: center;
		gap: 6px;
		cursor: default;
	}

	.context-label {
		font-size: 0.7rem;
		color: var(--text-secondary);
		white-space: nowrap;
	}

	.context-bar {
		width: 48px;
		height: 4px;
		background: var(--border);
		border-radius: 2px;
		overflow: hidden;
	}

	.context-fill {
		height: 100%;
		border-radius: 2px;
		transition:
			width 0.3s ease,
			background 0.3s ease;
	}
</style>
