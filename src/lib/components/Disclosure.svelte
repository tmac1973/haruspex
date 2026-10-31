<script lang="ts">
	/**
	 * A fold for the less-used settings inside a form section: a chevron and
	 * a label, no box. The job editor had four looks for this (a bordered
	 * box, a rule above, a bare `<details>`, the section cards themselves);
	 * one look lets the eye learn it once.
	 *
	 * The body stays mounted while folded, only hidden, so its fields keep
	 * their state and stay reachable by label in tests, as `<details>` did.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		label: string;
		open?: boolean;
		children: Snippet;
	}

	let { label, open = $bindable(false), children }: Props = $props();

	const id = $props.id();
</script>

<div class="disclosure">
	<button
		type="button"
		class="disclosure-head"
		aria-expanded={open}
		aria-controls={id}
		onclick={() => (open = !open)}
	>
		<svg
			class="chevron"
			class:open
			width="10"
			height="10"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<polyline points="6 9 12 15 18 9"></polyline>
		</svg>
		{label}
	</button>
	<div {id} class="disclosure-body" hidden={!open}>
		{@render children()}
	</div>
</div>

<style>
	.disclosure-head {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		padding: 4px 0;
		background: none;
		border: none;
		color: var(--text-secondary);
		font: inherit;
		font-size: 0.82rem;
		cursor: pointer;
	}

	.disclosure-head:hover {
		color: var(--text-primary);
	}

	.chevron {
		flex: none;
		transform: rotate(-90deg);
		transition: transform 0.15s;
	}

	.chevron.open {
		transform: rotate(0deg);
	}

	.disclosure-body {
		display: flex;
		flex-direction: column;
		gap: 12px;
		margin-top: 8px;
		padding-left: 17px;
	}

	.disclosure-body[hidden] {
		display: none;
	}
</style>
