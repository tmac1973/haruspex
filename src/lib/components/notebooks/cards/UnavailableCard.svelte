<script lang="ts">
	/** A card of a kind this version can't show. It can still be moved or deleted. */
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card }: CardViewProps = $props();
</script>

<p class="unavailable" title="Card type: {card.kind}">
	This card type isn't available in this version.
</p>

<style>
	.unavailable {
		margin: 0;
		color: var(--text-muted);
		font-size: 0.85rem;
		font-style: italic;
	}
</style>
