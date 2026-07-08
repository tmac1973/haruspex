<script lang="ts">
	/**
	 * Checkbox row with a bold title and secondary description — the
	 * "toggle-row" pattern the inference forms and settings sections share.
	 * Pass `description` for plain text, or children for rich content
	 * (inline markup, conditionals). Styling comes from the global
	 * `.toggle-row` class in +layout.svelte.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		checked: boolean;
		onchange: (val: boolean) => void;
		title: string;
		description?: string;
		children?: Snippet;
	}

	let { checked, onchange, title, description, children }: Props = $props();
</script>

<label class="toggle-row">
	<input type="checkbox" {checked} onchange={(e) => onchange(e.currentTarget.checked)} />
	<div>
		<strong>{title}</strong>
		<span>
			{#if children}{@render children()}{:else}{description}{/if}
		</span>
	</div>
</label>
