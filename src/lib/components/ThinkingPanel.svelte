<!--
	A disclosure for a model's reasoning that keeps its own open state.

	The state has to live in a component, not in an attribute on generated
	HTML. ChatMessage re-derives its whole HTML string on every streaming delta
	and injects it with {@html}, so a <details> in that string is destroyed and
	rebuilt — collapsed — on every update. A component has a stable identity: a
	text change re-renders the body and leaves the disclosure alone.

	`defaultOpen` seeds the initial state and is deliberately not reactive
	afterwards. A derived `open` was the second half of the same bug: whatever
	the user clicked was overridden the next time the expression flipped.
-->
<script lang="ts">
	interface Props {
		/** The reasoning text. Updates freely without disturbing `open`. */
		text: string;
		/** Initial state only — never re-applied. */
		defaultOpen?: boolean;
		/** Optional right-aligned summary, e.g. the thinking-time stat. */
		stat?: string;
		/** True while this reasoning is still being generated. */
		live?: boolean;
	}

	const { text, defaultOpen = false, stat, live = false }: Props = $props();

	// Capturing only the initial value is the entire point: re-applying
	// `defaultOpen` on every change is the bug this component exists to fix.
	// svelte-ignore state_referenced_locally
	let open = $state(defaultOpen);
</script>

<details class="thinking-panel" {open} ontoggle={(e) => (open = e.currentTarget.open)}>
	<summary>
		<span class="title">{live ? 'Thinking…' : 'Reasoning'}</span>
		{#if stat}<span class="stat">{stat}</span>{/if}
	</summary>
	<pre class="body">{text}</pre>
</details>

<style>
	.thinking-panel {
		margin: 6px 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
	}

	summary {
		cursor: pointer;
		padding: 6px 10px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		display: flex;
		gap: 8px;
		align-items: baseline;
	}

	.title {
		font-weight: 500;
	}

	.stat {
		font-size: 0.75rem;
		opacity: 0.85;
	}

	.body {
		margin: 0;
		padding: 0 10px 10px 10px;
		font-size: 0.8rem;
		line-height: 1.45;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--text-secondary);
		max-height: 22rem;
		overflow-y: auto;
	}
</style>
