import { getHomeCards } from '#lib/stores/homeCards.svelte.ts';
import type { HomeEvent } from '#lib/engine/types.ts';

/**
 * A `home-card` event for each card added, removed or changed in its row
 * (moved, resized, a new fetched result), with a `seq` of its own. Main
 * window only. It watches the cards as Home has them loaded and loads none:
 * in lean mode, where nothing loads them, there is nothing to watch.
 */
export function watchHome(sink: (e: HomeEvent) => void): { stop: () => void } {
	let seq = 0;
	let known: Map<string, string> | null = null;
	const stop = $effect.root(() => {
		$effect(() => {
			// Bookkeeping, never rendered: not a SvelteMap.
			// eslint-disable-next-line svelte/prefer-svelte-reactivity
			const next = new Map(getHomeCards().map((c) => [c.id, JSON.stringify(c)]));
			const before = known;
			known = next;
			// The first look is where we start from, not a change.
			if (!before) return;
			const changed = [
				...[...next.keys()].filter((id) => before.get(id) !== next.get(id)),
				...[...before.keys()].filter((id) => !next.has(id))
			];
			for (const id of changed) sink({ type: 'home-card', seq: ++seq, cardId: id });
		});
	});
	return { stop };
}
