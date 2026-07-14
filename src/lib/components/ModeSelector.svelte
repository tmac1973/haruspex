<script lang="ts" generics="T extends string">
	/**
	 * Segmented control: one exclusive choice rendered as a single row of
	 * equal-width buttons — the active one fills with the accent. The app's
	 * standard "pick a mode" control — inference backend, job model source,
	 * response format, proxy mode — so the choice UIs can't drift apart.
	 *
	 * Each option's one-line description is shown under the track for the
	 * active choice (and as a tooltip on every button), so no information
	 * from the old radio-card layout is lost. The hidden radio inputs keep
	 * native group semantics and keyboard behavior.
	 *
	 * Track/button styling comes from the global `.segmented` classes in
	 * +layout.svelte.
	 */
	interface ModeOption {
		value: T;
		title: string;
		description: string;
	}

	interface Props {
		/** Radio group name — must be unique per form. */
		name: string;
		value: T;
		options: ModeOption[];
		onchange: (value: T) => void;
		/** Kept for API compatibility — the segmented control is always a row. */
		direction?: 'row' | 'column';
	}

	let { name, value, options, onchange }: Props = $props();

	const active = $derived(options.find((o) => o.value === value));
</script>

<div class="mode-selector">
	<div class="segmented" role="radiogroup">
		{#each options as opt (opt.value)}
			<label class:active={value === opt.value} title={opt.description}>
				<input
					type="radio"
					{name}
					value={opt.value}
					checked={value === opt.value}
					onchange={() => onchange(opt.value)}
				/>
				{opt.title}
			</label>
		{/each}
	</div>
	{#if active?.description}
		<span class="description">{active.description}</span>
	{/if}
</div>

<style>
	.mode-selector {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	/* The radio stays focusable for keyboard/screen-reader users; the label
	   is the visible button. */
	input[type='radio'] {
		position: absolute;
		width: 1px;
		height: 1px;
		opacity: 0;
		pointer-events: none;
	}

	label {
		position: relative;
		user-select: none;
	}

	label:has(input:focus-visible) {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.description {
		font-size: 0.78rem;
		color: var(--text-muted);
	}
</style>
