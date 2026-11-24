<script lang="ts">
	// Lightweight image viewer. Dismissable on backdrop click or Escape;
	// distinct from the confirmation Modal which deliberately resists
	// dismissal. A cached picture (a drawn one, or one fetched into an
	// answer) can be saved from here. With `onStep`, ← and → (and the side
	// buttons) move through a set of pictures, such as a job's stills.

	import { dismissable } from '#lib/actions/dismissable.ts';
	import { imageHashFromUrl } from '#lib/images/url.ts';
	import { saveImageAs } from '#lib/images/save.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		src: string | null;
		alt?: string;
		onClose: () => void;
		/** "2 of 5", shown with the caption when the picture is one of a set. */
		position?: string;
		/** Move through the set: -1 back, 1 on. */
		onStep?: (by: number) => void;
	}

	let { src, alt = 'image', onClose, position, onStep }: Props = $props();

	function onKeydown(e: KeyboardEvent) {
		if (!src || !onStep) return;
		if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
			e.preventDefault();
			onStep(e.key === 'ArrowLeft' ? -1 : 1);
		}
	}

	function step(e: Event, by: number) {
		e.stopPropagation();
		onStep?.(by);
	}

	const hash = $derived(src ? imageHashFromUrl(src) : null);
	let note = $state('');
	$effect(() => {
		void src;
		note = '';
	});

	async function saveAs(e: Event) {
		e.stopPropagation();
		if (!hash) return;
		try {
			const result = await saveImageAs(hash, alt);
			if (result.kind === 'saved') note = `Saved to ${result.path}`;
		} catch (err) {
			note = `Could not save: ${errMessage(err)}`;
		}
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if src}
	<div class="viewer-backdrop" use:dismissable={onClose}>
		{#if position}
			<p class="viewer-caption">{position}{alt && alt !== 'image' ? ` · ${alt}` : ''}</p>
		{/if}
		<div class="viewer-actions">
			{#if hash}
				<button class="viewer-button viewer-save" onclick={saveAs} title="Save as…">
					Save as…
				</button>
			{/if}
			<button class="modal-close viewer-close" onclick={onClose} aria-label="Close">×</button>
		</div>
		<img class="viewer-img" {src} {alt} />
		{#if onStep}
			<button
				class="viewer-step viewer-prev"
				onclick={(e) => step(e, -1)}
				aria-label="Previous picture"
				title="Previous (←)"
			>
				‹
			</button>
			<button
				class="viewer-step viewer-next"
				onclick={(e) => step(e, 1)}
				aria-label="Next picture"
				title="Next (→)"
			>
				›
			</button>
		{/if}
		{#if note}
			<!-- svelte-ignore a11y_click_events_have_key_events -->
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<p class="viewer-note" onclick={(e) => e.stopPropagation()}>{note}</p>
		{/if}
	</div>
{/if}

<style>
	.viewer-backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.85);
		display: flex;
		align-items: center;
		justify-content: center;
		z-index: 2000;
		cursor: zoom-out;
	}
	.viewer-img {
		max-width: 90vw;
		max-height: 90vh;
		object-fit: contain;
		box-shadow: 0 4px 24px rgba(0, 0, 0, 0.6);
		cursor: default;
		background: white;
	}
	.viewer-actions {
		position: absolute;
		top: 16px;
		right: 16px;
		display: flex;
		align-items: center;
		gap: 10px;
	}
	/* Overrides of the global .modal-close: floats over a near-black
	   backdrop, so it needs its own white-on-dark circular look. */
	.viewer-close {
		position: static;
		width: 36px;
		height: 36px;
		border-radius: 50%;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 24px;
	}
	.viewer-close:hover {
		color: white;
		background: rgba(255, 255, 255, 0.25);
	}
	.viewer-save {
		height: 36px;
		padding: 0 14px;
		border: none;
		border-radius: 18px;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 0.85rem;
		cursor: pointer;
	}
	.viewer-save:hover {
		background: rgba(255, 255, 255, 0.25);
	}
	.viewer-caption {
		position: absolute;
		top: 22px;
		left: 16px;
		margin: 0;
		color: white;
		font-size: 0.85rem;
		max-width: 60vw;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		cursor: default;
	}
	.viewer-step {
		position: absolute;
		top: 50%;
		transform: translateY(-50%);
		width: 44px;
		height: 64px;
		border: none;
		border-radius: 8px;
		background: rgba(255, 255, 255, 0.15);
		color: white;
		font-size: 32px;
		line-height: 1;
		cursor: pointer;
	}
	.viewer-step:hover {
		background: rgba(255, 255, 255, 0.25);
	}
	.viewer-prev {
		left: 16px;
	}
	.viewer-next {
		right: 16px;
	}
	.viewer-note {
		position: absolute;
		bottom: 16px;
		left: 50%;
		transform: translateX(-50%);
		margin: 0;
		padding: 6px 12px;
		border-radius: 6px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 0.8rem;
		cursor: default;
		max-width: 90vw;
		overflow-wrap: anywhere;
	}
</style>
