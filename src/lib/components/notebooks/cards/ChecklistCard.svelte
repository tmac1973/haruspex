<script lang="ts">
	/**
	 * A checklist card: items to tick off. Enter adds the next item, Backspace
	 * in an empty one removes it, and items drag to reorder.
	 */
	import { tick } from 'svelte';
	import * as api from '#lib/notebooks/api.ts';
	import { applyRows } from '#lib/stores/notebooks.svelte.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card, readonly = false }: CardViewProps = $props();

	interface Item {
		id: string;
		text: string;
		done: boolean;
	}

	const items = $derived<Item[]>(
		card.rows.map((r) => {
			const c = api.parseMeta<{ text?: unknown; done?: unknown }>(r.cells);
			return { id: r.id, text: typeof c.text === 'string' ? c.text : '', done: c.done === true };
		})
	);

	let hideDone = $state(false);
	const shown = $derived(hideDone ? items.filter((i) => !i.done) : items);
	const doneCount = $derived(items.filter((i) => i.done).length);

	let drafts = $state<Record<string, string>>({});
	let dragId: string | null = null;

	const cellsOf = (i: Item, patch: Partial<Item> = {}) =>
		JSON.stringify({ text: patch.text ?? i.text, done: patch.done ?? i.done });

	async function toggle(i: Item) {
		if (readonly) return;
		await applyRows(card, [{ op: 'update', row_id: i.id, cells: cellsOf(i, { done: !i.done }) }]);
	}

	async function saveText(i: Item) {
		const text = drafts[i.id];
		if (text === undefined || text === i.text) return;
		delete drafts[i.id];
		await applyRows(card, [{ op: 'update', row_id: i.id, cells: cellsOf(i, { text }) }]);
	}

	async function addAfter(after: string | null) {
		// Read before saving: the card updates as soon as the save returns.
		const before = new Set(items.map((i) => i.id));
		const saved = await applyRows(card, [
			{ op: 'add', after, cells: JSON.stringify({ text: '', done: false }) }
		]);
		if (!saved) return;
		// The new row is the one that wasn't there before.
		const fresh = saved.rows.find((r) => !before.has(r.id));
		if (fresh) {
			await tick();
			document.getElementById(`nb-check-${fresh.id}`)?.focus();
		}
	}

	async function remove(i: Item, focusPrev: boolean) {
		const idx = items.findIndex((x) => x.id === i.id);
		await applyRows(card, [{ op: 'delete', row_id: i.id }]);
		if (focusPrev && idx > 0) {
			await tick();
			document.getElementById(`nb-check-${items[idx - 1]?.id}`)?.focus();
		}
	}

	async function onKey(e: KeyboardEvent, i: Item) {
		const input = e.currentTarget as HTMLInputElement;
		if (e.key === 'Enter') {
			e.preventDefault();
			await saveText(i);
			await addAfter(i.id);
		} else if (e.key === 'Backspace' && input.value === '') {
			e.preventDefault();
			await remove(i, true);
		}
	}

	async function drop(targetId: string) {
		const id = dragId;
		dragId = null;
		if (!id || id === targetId) return;
		await applyRows(card, [{ op: 'move', row_id: id, after: targetId }]);
	}
</script>

<ul class="checklist">
	{#each shown as item (item.id)}
		<li
			id="nb-row-{item.id}"
			class:done={item.done}
			ondragover={(e) => {
				if (dragId) e.preventDefault();
			}}
			ondrop={(e) => {
				e.preventDefault();
				void drop(item.id);
			}}
		>
			{#if !readonly}
				<span
					class="grip"
					draggable="true"
					role="button"
					tabindex="-1"
					aria-label="Drag to move"
					ondragstart={() => (dragId = item.id)}
				>
					⋮⋮
				</span>
			{/if}
			<input
				type="checkbox"
				checked={item.done}
				disabled={readonly}
				aria-label="Done"
				onchange={() => void toggle(item)}
			/>
			<input
				class="text"
				id="nb-check-{item.id}"
				value={drafts[item.id] ?? item.text}
				{readonly}
				placeholder="Item"
				aria-label="Item"
				oninput={(e) => (drafts[item.id] = e.currentTarget.value)}
				onblur={() => void saveText(item)}
				onkeydown={(e) => void onKey(e, item)}
			/>
		</li>
	{/each}
</ul>
<div class="foot">
	{#if !readonly}
		<button class="mini" onclick={() => void addAfter(items.at(-1)?.id ?? null)}>+ Item</button>
	{/if}
	{#if doneCount > 0}
		<button class="mini" aria-pressed={hideDone} onclick={() => (hideDone = !hideDone)}>
			{hideDone ? `Show done (${doneCount})` : 'Hide done'}
		</button>
	{/if}
	<span class="count">{doneCount} of {items.length} done</span>
</div>

<style>
	.checklist {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	li {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 0;
	}

	.grip {
		color: var(--text-faint);
		cursor: grab;
		font-size: 0.7rem;
		letter-spacing: -2px;
		opacity: 0;
	}

	li:hover .grip {
		opacity: 1;
	}

	.text {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font: inherit;
		font-size: 0.92rem;
		padding: 3px 4px;
		border-radius: 4px;
	}

	.text:focus {
		outline: 1px solid var(--border-strong);
		background: var(--bg-input);
	}

	li.done .text {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}

	.mini {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 3px 6px;
		border-radius: 4px;
		font-size: 0.82rem;
	}

	.mini:hover {
		color: var(--accent);
		background: var(--bg-primary);
	}

	.count {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.75rem;
	}
</style>
