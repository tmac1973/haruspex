<script lang="ts">
	/**
	 * Save as… on a picture in Chat, over its top-right corner: the strip
	 * under an answer and a step's thumbnails and plots. Pictures written into
	 * an answer's markdown get the same button from `images/figure.ts`, routed
	 * by `markdown-actions.ts`. The parent is `position: relative` and shows
	 * it on hover through `.image-save`.
	 */
	import { saveDataUrlImageAs, saveImageAs, saveWithToast } from '#lib/images/save.ts';

	interface Props {
		/** A cached picture's hash, or else */
		hash?: string;
		/** a picture held only as a `data:` URL. */
		dataUrl?: string;
		alt: string;
	}
	let { hash, dataUrl, alt }: Props = $props();

	function onclick(e: MouseEvent) {
		e.stopPropagation();
		if (hash) void saveWithToast(() => saveImageAs(hash, alt));
		else if (dataUrl) void saveWithToast(() => saveDataUrlImageAs(dataUrl, alt));
	}
</script>

<button type="button" class="image-save" {onclick} title="Save as…" aria-label="Save image as…">
	<svg viewBox="0 0 24 24" aria-hidden="true"
		><path d="M12 4v11"></path><polyline points="7 10 12 15 17 10"></polyline><path d="M5 19h14"
		></path></svg
	>
</button>
