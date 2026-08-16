<script lang="ts">
	// The presentational half of the context indicator: given a token count and
	// a ceiling, draw the label and the bar. Split out of ContextIndicator so
	// the same gauge can be driven by the global chat store (that component) or
	// by a job step's own usage against the job's own model — which is the
	// whole point, since a job may run on a different model with a different
	// window than the one Settings has active.
	interface Props {
		promptTokens: number;
		contextSize: number;
		/** Prefix for the hover title, e.g. the job or model name. */
		label?: string;
		/** Render the numbers without the bar, for tight rows. */
		compact?: boolean;
	}

	import { formatTokens } from '$lib/utils/format';

	const { promptTokens, contextSize, label, compact = false }: Props = $props();

	const visible = $derived(promptTokens > 0 && contextSize > 0);
	const percent = $derived(contextSize > 0 ? (promptTokens / contextSize) * 100 : 0);

	function barColor(pct: number): string {
		if (pct >= 80) return 'var(--error-text)';
		if (pct >= 60) return 'var(--warning)';
		return 'var(--accent)';
	}

	const title = $derived(
		`${label ? `${label} — ` : ''}Prompt: ${promptTokens.toLocaleString()} tokens | ` +
			`Context: ${contextSize.toLocaleString()} tokens (${percent.toFixed(1)}%)`
	);
</script>

{#if visible}
	<div class="context-indicator" {title}>
		<span class="context-label">
			{formatTokens(promptTokens)} / {formatTokens(contextSize)}
		</span>
		{#if !compact}
			<div class="context-bar">
				<div
					class="context-fill"
					style="width: {Math.min(percent, 100)}%; background: {barColor(percent)}"
				></div>
			</div>
		{/if}
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
