<script lang="ts">
	/**
	 * What pictures and clips on OpenRouter have cost since the count began,
	 * with a button to start it again. The same count shows under Settings →
	 * Image generation and Settings → Video generation.
	 */
	import { generationSpend, resetGenerationSpend } from '#lib/generation/spend.svelte.ts';
	import { formatUsd, plural } from '#lib/utils/format.ts';

	/** The section has an OpenRouter model; the line shows then, or once anything was spent. */
	let { paid }: { paid: boolean } = $props();

	const spend = $derived(generationSpend());
	const made = $derived(spend.pictures + spend.clips);
	const since = $derived(
		new Date(spend.since).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
	);
	const what = $derived(
		[
			spend.pictures ? plural(spend.pictures, 'picture') : '',
			spend.clips ? plural(spend.clips, 'clip') : ''
		]
			.filter(Boolean)
			.join(' and ')
	);
	const tip = $derived(
		'The price OpenRouter reported for each picture and clip, across Settings → Image ' +
			'generation and Settings → Video generation.' +
			(spend.unpriced ? ` ${plural(spend.unpriced, 'result')} came with no price.` : '')
	);
</script>

{#if paid || made > 0}
	<p class="help spend" title={tip}>
		<span>
			Spent on OpenRouter since {since}: {formatUsd(spend.usd)}{what ? `, on ${what}` : ''}.
		</span>
		{#if made > 0}
			<button
				class="btn btn-small"
				title="Start the count again from today"
				onclick={resetGenerationSpend}
			>
				Reset
			</button>
		{/if}
	</p>
{/if}

<style>
	.spend {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-wrap: wrap;
	}
</style>
