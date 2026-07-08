<script lang="ts" generics="T extends string">
	/**
	 * Radio-card group: one exclusive choice where each option shows a bold
	 * title plus a one-line description, and the selected card is outlined in
	 * the accent color. The app's standard "pick a mode" control — inference
	 * backend, job model source, response format, proxy mode — so the choice
	 * UIs can't drift apart.
	 *
	 * `direction="row"` lays the cards side by side (equal widths); the
	 * default column stacks them, which reads better for 3+ options with
	 * longer descriptions.
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
		direction?: 'row' | 'column';
	}

	let { name, value, options, onchange, direction = 'column' }: Props = $props();
</script>

<div class="mode-selector" class:row={direction === 'row'}>
	{#each options as opt (opt.value)}
		<label class="mode-option" class:selected={value === opt.value}>
			<input
				type="radio"
				{name}
				value={opt.value}
				checked={value === opt.value}
				onchange={() => onchange(opt.value)}
			/>
			<div>
				<strong>{opt.title}</strong>
				<span>{opt.description}</span>
			</div>
		</label>
	{/each}
</div>

<style>
	.mode-selector {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.mode-selector.row {
		flex-direction: row;
		flex-wrap: wrap;
	}

	.mode-selector.row .mode-option {
		flex: 1;
		min-width: 160px;
	}

	.mode-option {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-radius: 8px;
		cursor: pointer;
		transition: border-color 0.15s;
	}

	.mode-option:hover {
		border-color: var(--text-secondary);
	}

	.mode-option.selected {
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 5%, transparent);
	}

	.mode-option input[type='radio'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.mode-option strong {
		display: block;
		font-size: 0.9rem;
	}

	.mode-option span {
		display: block;
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}
</style>
