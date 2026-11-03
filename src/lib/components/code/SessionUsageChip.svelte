<script lang="ts">
	/**
	 * The session header's running count of tokens, sub-agents' included, and
	 * of cost on OpenRouter (`code/usageTotals.ts`). Compact; the tooltip has the breakdown. Hidden
	 * until the session's agent has made a call.
	 */
	import { formatCost, formatTokens, type SessionUsage } from '#lib/code/usageTotals.ts';

	let { totals }: { totals: SessionUsage } = $props();

	const total = $derived(totals.promptTokens + totals.completionTokens);
	const cost = $derived(
		totals.costUsd === null ? null : (totals.estimated ? '~' : '') + formatCost(totals.costUsd)
	);
	const tooltip = $derived(
		[
			`This session: ${total.toLocaleString()} tokens over ${totals.calls.toLocaleString()} model calls.`,
			`Sent: ${totals.promptTokens.toLocaleString()} · Written: ${totals.completionTokens.toLocaleString()}`,
			totals.costUsd === null
				? null
				: `Cost: $${totals.costUsd.toFixed(4)}${totals.estimated ? ' (part estimated from OpenRouter prices)' : ' (as OpenRouter reported it)'}`,
			totals.subagentCalls > 0
				? `Sub-agents: ${totals.subagentTokens.toLocaleString()} tokens over ${totals.subagentCalls.toLocaleString()} calls (included above).`
				: null,
			'Specialists and summaries are not counted.'
		]
			.filter(Boolean)
			.join('\n')
	);
</script>

{#if totals.calls > 0}
	<span class="chip" data-testid="session-usage" title={tooltip}>
		{formatTokens(total)} tok{#if cost}<span class="cost">{` · ${cost}`}</span>{/if}
	</span>
{/if}

<style>
	.chip {
		padding: 2px 7px;
		font-size: 0.72rem;
		font-variant-numeric: tabular-nums;
		border: 1px solid var(--border);
		border-radius: 999px;
		color: var(--text-secondary);
		white-space: nowrap;
		cursor: default;
	}

	.cost {
		color: var(--text-primary);
	}
</style>
