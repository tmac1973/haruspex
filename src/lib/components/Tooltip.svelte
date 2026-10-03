<script lang="ts">
	/**
	 * An ⓘ affordance with a hover/focus popover, for field help that would
	 * otherwise sit under the control as a paragraph.
	 *
	 * Why not the native `title` attribute the editors already carry: it gives
	 * no sign that help exists, waits about a second before appearing, can't be
	 * styled, and renders a 250-character explanation as one unbroken line.
	 * Discoverability is half the problem being solved.
	 *
	 * Placement note: these usually live inside a field's `<label>`. A click on
	 * a label forwards activation to its control, which would yank focus into
	 * the input every time the tooltip is toggled — the same trap the coding
	 * editor already documents for its `<details>` block. The trigger is a
	 * `<button type="button">` that stops the click, so the label never sees it.
	 *
	 * The popover is positioned against the VIEWPORT (`position: fixed`), not its
	 * parent. Positioned against the parent it was clipped by any card or scroll
	 * container with `overflow` set — the asset job's editor cut the top off its
	 * spec tooltip. It opens above the trigger, below when there is no room, and
	 * is kept inside the window horizontally.
	 */
	import { tick } from 'svelte';

	interface Props {
		/** The help text. Plain string — no markup, so it can't smuggle HTML. */
		text: string;
		/** Accessible name for the trigger, when "more information" is too vague. */
		label?: string;
	}

	const { text, label = 'More information' }: Props = $props();

	let open = $state(false);
	let id = $props.id();
	let trigger = $state<HTMLButtonElement | null>(null);
	let popover = $state<HTMLSpanElement | null>(null);
	/** Viewport coordinates, set once the popover can be measured. */
	let place = $state<{ top: number; left: number } | null>(null);

	/** Gap between trigger and popover, and the margin kept from the window edge. */
	const GAP = 6;
	const MARGIN = 8;

	async function position() {
		await tick();
		if (!open || !trigger || !popover) return;
		const t = trigger.getBoundingClientRect();
		const p = popover.getBoundingClientRect();
		const above = t.top - GAP - p.height;
		const top = above >= MARGIN ? above : t.bottom + GAP;
		const centred = t.left + t.width / 2 - p.width / 2;
		const left = Math.max(MARGIN, Math.min(centred, window.innerWidth - p.width - MARGIN));
		place = { top, left };
	}

	function show() {
		open = true;
		place = null;
		void position();
	}

	// Fixed to the viewport, so it has to follow its trigger when anything
	// scrolls — including the inner scroll containers, hence the capture.
	$effect(() => {
		if (!open) return;
		const follow = () => void position();
		window.addEventListener('scroll', follow, true);
		window.addEventListener('resize', follow);
		return () => {
			window.removeEventListener('scroll', follow, true);
			window.removeEventListener('resize', follow);
		};
	});

	function hide() {
		open = false;
	}

	function onClick(event: MouseEvent) {
		// Both are needed: preventDefault kills the label's forwarding of this
		// click to its control, stopPropagation keeps any ancestor handler
		// (a collapsible section header) from treating it as a toggle.
		event.preventDefault();
		event.stopPropagation();
		if (open) hide();
		else show();
	}

	async function onKeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape' || !open) return;
		event.stopPropagation();
		open = false;
		await tick();
		trigger?.focus();
	}
</script>

<span
	class="tooltip-wrap"
	onmouseenter={show}
	onmouseleave={hide}
	onkeydown={onKeydown}
	role="presentation"
	data-testid="tooltip-wrap"
>
	<button
		type="button"
		class="tooltip-trigger"
		aria-label={label}
		aria-expanded={open}
		aria-describedby={open ? id : undefined}
		bind:this={trigger}
		onclick={onClick}
		onfocus={show}
		onblur={hide}
	>
		<span aria-hidden="true">ⓘ</span>
	</button>
	{#if open}
		<span
			class="tooltip-popover"
			{id}
			role="tooltip"
			bind:this={popover}
			style:top={place ? `${place.top}px` : '0px'}
			style:left={place ? `${place.left}px` : '0px'}
			style:visibility={place ? 'visible' : 'hidden'}>{text}</span
		>
	{/if}
</span>

<style>
	.tooltip-wrap {
		position: relative;
		display: inline-flex;
		align-items: center;
		margin-left: 4px;
	}

	.tooltip-trigger {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 0;
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 0.85rem;
		line-height: 1;
		cursor: help;
		opacity: 0.7;
	}

	.tooltip-trigger:hover,
	.tooltip-trigger:focus-visible {
		opacity: 1;
		color: var(--accent);
	}

	.tooltip-popover {
		/* Against the viewport, so no ancestor's overflow can clip it. */
		position: fixed;
		z-index: 1000;
		/* Wide enough for a paragraph, capped so it never spans the editor. */
		width: max-content;
		max-width: 320px;
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		box-shadow: 0 4px 14px rgb(0 0 0 / 25%);
		color: var(--text-primary);
		font-size: 0.78rem;
		font-style: normal;
		font-weight: 400;
		line-height: 1.4;
		white-space: normal;
		text-align: left;
	}
</style>
