<script lang="ts">
	/**
	 * The memories manager: everything the app has remembered, with the means
	 * to correct or remove any of it.
	 *
	 * This is the half of the feature that makes the other half acceptable. A
	 * store you cannot read is a store you cannot trust, and a wrong fact you
	 * cannot delete is one that keeps being asserted into every future
	 * conversation.
	 *
	 * The filter is a plain substring match, not semantic search: you use it
	 * to find a memory you already know exists, having just seen the model act
	 * on it.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import type { MemoryMeta } from '$lib/ipc/gen/MemoryMeta';
	import { refreshMemoryCount } from '$lib/stores/memory.svelte';
	import MemoryRow from './MemoryRow.svelte';

	const PAGE_SIZE = 25;

	let memories = $state<MemoryMeta[]>([]);
	let filter = $state('');
	let offset = $state(0);
	let hasMore = $state(false);
	let loading = $state(false);
	let error = $state<string | null>(null);
	let confirmingClear = $state(false);
	let clearConfirmText = $state('');

	export async function reload(): Promise<void> {
		offset = 0;
		await load(true);
	}

	async function load(replace: boolean): Promise<void> {
		loading = true;
		error = null;
		try {
			const page = await invoke<MemoryMeta[]>('memory_list', {
				offset: replace ? 0 : offset,
				limit: PAGE_SIZE,
				filter: filter.trim() || null
			});
			memories = replace ? page : [...memories, ...page];
			offset = memories.length;
			// A full page means there may be more; a short one means there is
			// not. Cheaper than a second count query per page.
			hasMore = page.length === PAGE_SIZE;
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			loading = false;
		}
	}

	// Debounced so typing a filter does not fire a query per keystroke.
	let filterTimer: ReturnType<typeof setTimeout> | undefined;
	function onFilterInput() {
		clearTimeout(filterTimer);
		filterTimer = setTimeout(() => void reload(), 200);
	}

	async function saveMemory(id: string, content: string): Promise<void> {
		// Rust re-embeds on update — the vector is the other half of the fact,
		// and leaving it stale would recall this row for the old wording.
		await invoke('memory_update', { id, content });
		memories = memories.map((m) => (m.id === id ? { ...m, content } : m));
	}

	async function deleteMemory(id: string): Promise<void> {
		await invoke('memory_delete', { id });
		memories = memories.filter((m) => m.id !== id);
		void refreshMemoryCount();
	}

	async function clearAll(): Promise<void> {
		await invoke('memory_delete_all');
		confirmingClear = false;
		clearConfirmText = '';
		void refreshMemoryCount();
		await reload();
	}

	$effect(() => {
		void reload();
	});
</script>

<section class="settings-section">
	<h2>Remembered facts</h2>

	<input
		type="search"
		placeholder="Filter remembered facts…"
		bind:value={filter}
		oninput={onFilterInput}
		aria-label="Filter memories"
	/>

	{#if error}
		<p class="help error-line">Could not load memories: {error}</p>
	{:else if memories.length === 0}
		<p class="help">
			{filter.trim() ? 'Nothing matches that filter.' : 'Nothing remembered yet.'}
		</p>
	{:else}
		<ul class="rows">
			{#each memories as memory (memory.id)}
				<MemoryRow {memory} onsave={saveMemory} ondelete={deleteMemory} />
			{/each}
		</ul>
		{#if hasMore}
			<button type="button" class="btn" onclick={() => load(false)} disabled={loading}>
				{loading ? 'Loading…' : 'Show more'}
			</button>
		{/if}
	{/if}
</section>

{#if memories.length > 0 || filter.trim()}
	<section class="settings-section danger">
		<h2>Forget everything</h2>
		<p class="help">
			Deletes every remembered fact. The conversations themselves are untouched — but anything
			learned from them is gone, and the next chats start cold.
		</p>
		{#if confirmingClear}
			<!-- Typed confirmation, unlike a single row's delete: this one is not
			     recoverable and not obvious from looking at one thing. -->
			<p class="help">Type <strong>delete</strong> to confirm.</p>
			<input
				type="text"
				bind:value={clearConfirmText}
				aria-label="Type delete to confirm"
				placeholder="delete"
			/>
			<div class="actions">
				<button
					type="button"
					class="btn danger-btn"
					disabled={clearConfirmText.trim().toLowerCase() !== 'delete'}
					onclick={clearAll}
				>
					Delete everything
				</button>
				<button type="button" class="link" onclick={() => (confirmingClear = false)}>Cancel</button>
			</div>
		{:else}
			<button type="button" class="btn" onclick={() => (confirmingClear = true)}>
				Forget everything…
			</button>
		{/if}
	</section>
{/if}

<style>
	.rows {
		margin: 8px 0;
		padding: 0;
	}

	input[type='search'],
	input[type='text'] {
		width: 100%;
		margin-bottom: 6px;
	}

	.actions {
		display: flex;
		gap: 12px;
		align-items: center;
	}

	.danger-btn {
		border-color: var(--error, #d66);
		color: var(--error, #d66);
	}

	.error-line {
		color: var(--error, #d66);
	}
</style>
