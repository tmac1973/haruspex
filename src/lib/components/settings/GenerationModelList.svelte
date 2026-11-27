<script lang="ts" generics="E extends { id: string; name: string; disabled?: boolean }">
	/**
	 * The ordered list of generation models a Settings section keeps (image,
	 * video, upscalers): a row per model with an on/off box, its place, up and
	 * down, Remove, a line on
	 * what it can do, and its editor under it. One row's editor is open at a
	 * time. The section owns the list; this only shows it and reports clicks.
	 */
	import type { Snippet } from 'svelte';

	interface Props {
		entries: E[];
		/** Where it runs, for its row. */
		place: (e: E) => string;
		/** What it can do, with detail for a tooltip; null before a probe. */
		capsLine: (e: E) => { text: string; title?: string } | null;
		onMove: (id: string, delta: -1 | 1) => void;
		/** Turn a model on or off; it stays in the list either way. */
		onEnable: (e: E, on: boolean) => void;
		onRemove: (e: E) => void;
		editor: Snippet<[E]>;
		openId: string | null;
	}

	let {
		entries,
		place,
		capsLine,
		onMove,
		onEnable,
		onRemove,
		editor,
		openId = $bindable()
	}: Props = $props();

	function toggle(id: string) {
		openId = openId === id ? null : id;
	}
</script>

<ol class="entries">
	{#each entries as e, i (e.id)}
		{@const line = capsLine(e)}
		<li class="entry" class:open={openId === e.id} class:off={e.disabled}>
			<div class="entry-head">
				<input
					type="checkbox"
					aria-label={`Use ${e.name}`}
					title={e.disabled ? 'Off: kept, but not used' : 'On: used when it can do the job'}
					checked={!e.disabled}
					onchange={(ev) => onEnable(e, ev.currentTarget.checked)}
				/>
				<button class="entry-name" aria-expanded={openId === e.id} onclick={() => toggle(e.id)}>
					<strong>{e.name}</strong>
					<span class="where">{place(e)}</span>
				</button>
				<button
					aria-label={`Move ${e.name} up`}
					title="Try it earlier"
					disabled={i === 0}
					onclick={() => onMove(e.id, -1)}
				>
					↑
				</button>
				<button
					aria-label={`Move ${e.name} down`}
					title="Try it later"
					disabled={i === entries.length - 1}
					onclick={() => onMove(e.id, 1)}
				>
					↓
				</button>
				<button aria-label={`Remove ${e.name}`} onclick={() => onRemove(e)}>Remove</button>
			</div>
			{#if e.disabled}
				<p class="help">Off.</p>
			{:else if line}
				<p class="help" title={line.title || undefined}>{line.text}</p>
			{:else}
				<p class="help">Not probed yet.</p>
			{/if}
			{#if openId === e.id}
				<div class="editor">
					{#key e.id}
						{@render editor(e)}
					{/key}
				</div>
			{/if}
		</li>
	{/each}
</ol>

<style>
	.entries {
		list-style: none;
		padding: 0;
		margin: 8px 0 0;
		display: flex;
		flex-direction: column;
		gap: 8px;
	}

	.entry {
		border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
		border-radius: 6px;
		padding: 8px 10px;
	}

	.entry.off .entry-name {
		opacity: 0.55;
	}

	.entry-head {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.entry-name {
		flex: 1;
		min-width: 0;
		display: flex;
		align-items: baseline;
		gap: 8px;
		text-align: left;
		background: none;
		border: none;
		padding: 2px 0;
		cursor: pointer;
		color: inherit;
		font: inherit;
	}

	.where {
		font-size: 0.85em;
		color: var(--text-muted, #888);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.editor {
		margin-top: 8px;
		padding-top: 8px;
		border-top: 1px solid var(--border, rgba(127, 127, 127, 0.2));
	}
</style>
