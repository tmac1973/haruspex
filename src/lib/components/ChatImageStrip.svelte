<script lang="ts">
	/**
	 * Pictures shown beneath an answer when the model searched for images but
	 * did not write any into its reply.
	 *
	 * Running `image_search` is the model's statement of intent — it picked the
	 * query and made the call — and it never sees the results, only their
	 * titles and licences. So a search followed by no embed is the model
	 * forgetting its last step far more often than it is a judgement about
	 * pictures it cannot look at. This shows them rather than losing them.
	 *
	 * Inline placement next to the relevant paragraph is still the better
	 * outcome, so `stripFor` returns nothing whenever the answer embedded an
	 * image of its own.
	 */
	import type { ImageRow } from '$lib/ipc/gen/ImageRow';
	import { captionFor } from '$lib/images/caption';
	import { imageSrc } from '$lib/images/url';

	interface Props {
		images: ImageRow[];
	}

	let { images }: Props = $props();
</script>

{#if images.length > 0}
	<div class="image-strip">
		{#each images as row (row.hash)}
			{@const src = imageSrc(row.hash)}
			{@const caption = captionFor(row)}
			{#if src}
				<figure>
					<img {src} alt="" width={row.width} height={row.height} loading="lazy" />
					{#if caption}
						<figcaption>
							{caption.text}{#if caption.linkHref}<a
									href={caption.linkHref}
									target="_blank"
									rel="noreferrer noopener">{caption.linkLabel}</a
								>{:else}{caption.linkLabel}{/if}
						</figcaption>
					{/if}
				</figure>
			{/if}
		{/each}
	</div>
{/if}

<style>
	/* Wraps rather than scrolls: at most three images, and a horizontal
	   scroller would hide the later ones behind an interaction. */
	.image-strip {
		display: flex;
		flex-wrap: wrap;
		gap: 10px;
		margin-top: 0.75rem;
	}

	figure {
		margin: 0;
		/* Sized so two sit side by side in a normal window and one fills the
		   width when the pane is narrow. */
		flex: 1 1 200px;
		max-width: 280px;
	}

	img {
		display: block;
		width: 100%;
		height: auto;
		max-height: 14rem;
		object-fit: cover;
		border-radius: 8px;
		border: 1px solid var(--border);
	}

	/* CC BY and CC BY-SA require credit wherever the image is shown, so this
	   is generated from stored provenance and not from anything the model
	   wrote. */
	figcaption {
		margin-top: 0.25rem;
		font-size: 0.7rem;
		color: var(--text-muted);
		line-height: 1.3;
	}

	figcaption a {
		color: var(--text-muted);
		text-decoration: underline;
	}

	figcaption a:hover {
		color: var(--text-secondary);
	}
</style>
