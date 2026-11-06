<script lang="ts" module>
	/** Kept across tabs and windows: whether the job's earlier tries are listed. */
	let showAttempts = false;
</script>

<script lang="ts">
	/**
	 * Beside a tab: the other files of its kind under the window's folder, as
	 * a tree to step through with the arrow keys or a click, and a switch to
	 * the other kinds the folder holds. Hidden while there is nothing else to
	 * show.
	 */
	import { onMount, untrack } from 'svelte';
	import { SvelteSet } from 'svelte/reactivity';
	import { invoke } from '@tauri-apps/api/core';
	import {
		KINDS,
		ancestors,
		countKinds,
		isAttempt,
		kindOf,
		stepFile,
		treeRows,
		visibleFiles,
		type ListKind
	} from '#lib/editor/fileTree.ts';
	import type { FileListing } from '#lib/ipc/gen/FileListing.ts';

	let {
		workdir,
		relPath,
		onpick
	}: {
		workdir: string;
		relPath: string;
		/** Show this file in place of the one showing. */
		onpick: (relPath: string) => void;
	} = $props();

	let listing = $state.raw<FileListing | null>(null);
	let attempts = $state(showAttempts);
	/** Folders, `/`-ended, whose files are hidden. */
	const collapsed = new SvelteSet<string>();
	const kind = $derived(kindOf(relPath));
	const files = $derived(listing ? visibleFiles(listing.files, relPath, kind, attempts) : []);
	const rows = $derived(treeRows(files, collapsed));
	const counts = $derived(listing ? countKinds(listing.files, attempts) : new Map());
	const kinds = $derived(KINDS.filter((k) => k.kind === kind || counts.has(k.kind)));
	const hasAttempts = $derived(listing?.files.some(isAttempt) ?? false);
	const shown = $derived(files.length > 1 || kinds.length > 1);
	let activeItem: HTMLElement | undefined = $state();

	// Stepping into a collapsed folder opens it.
	$effect(() => {
		const open = ancestors(relPath);
		untrack(() => open.forEach((d) => collapsed.delete(d)));
	});

	$effect(() => {
		// jsdom has no scrollIntoView.
		activeItem?.scrollIntoView?.({ block: 'nearest' });
	});

	async function refresh(): Promise<void> {
		try {
			listing = await invoke<FileListing>('editor_list_files', { workdir });
		} catch (e) {
			console.warn('Listing files failed', e);
		}
	}

	onMount(() => void refresh());

	// The tree stays up across tabs: a file it hasn't seen means the folder changed.
	let lookedFor = '';
	$effect(() => {
		if (!listing || listing.files.includes(relPath) || lookedFor === relPath) return;
		lookedFor = relPath;
		void refresh();
	});

	function step(delta: number): void {
		const next = stepFile(files, relPath, delta);
		if (next) onpick(next);
	}

	function switchTo(to: ListKind): void {
		if (to === kind || !listing) return;
		const first = visibleFiles(listing.files, '', to, attempts)[0];
		if (first) onpick(first);
	}

	function toggle(dir: string): void {
		if (!collapsed.delete(dir)) collapsed.add(dir);
	}

	const KEYS: Record<string, number> = { ArrowUp: -1, ArrowLeft: -1, ArrowDown: 1, ArrowRight: 1 };

	function onKeydown(e: KeyboardEvent): void {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
		const delta = KEYS[e.key];
		if (!delta) return;
		const t = e.target;
		if (t instanceof Element && t.closest('input, select, textarea, [contenteditable]')) return;
		e.preventDefault();
		step(delta);
	}

	function toggleAttempts(on: boolean): void {
		attempts = on;
		showAttempts = on;
	}
</script>

<svelte:window onkeydown={onKeydown} />

{#if shown}
	<nav class="files" aria-label="Files in this folder">
		{#if kinds.length > 1}
			<div class="kinds" role="group" aria-label="Kind">
				{#each kinds as k (k.kind)}
					<button
						class:on={k.kind === kind}
						aria-pressed={k.kind === kind}
						onclick={() => switchTo(k.kind)}>{k.label} {counts.get(k.kind) ?? 0}</button
					>
				{/each}
			</div>
		{/if}
		<div class="head">
			<button onclick={() => step(-1)} title="Previous (↑ or ←)" aria-label="Previous">‹</button>
			<button onclick={() => step(1)} title="Next (↓ or →)" aria-label="Next">›</button>
			<span
				class="count"
				title={listing?.truncated ? 'Only the first 2,000 of each sort are listed' : undefined}
				>{files.length}{listing?.truncated ? '+' : ''}</span
			>
			{#if hasAttempts}
				<label title="List the earlier tries the 3D models job keeps in attempts/">
					<input
						type="checkbox"
						checked={attempts}
						onchange={(e) => toggleAttempts(e.currentTarget.checked)}
					/>
					Attempts
				</label>
			{/if}
			<button
				class="refresh"
				onclick={() => void refresh()}
				title="Look again for new files"
				aria-label="Refresh">↻</button
			>
		</div>
		<ul>
			{#each rows as row (row.path)}
				<li style:--depth={row.depth}>
					{#if row.dir}
						<button
							class="dir"
							aria-expanded={!collapsed.has(row.path)}
							title={row.path}
							onclick={() => toggle(row.path)}
						>
							<span class="caret">{collapsed.has(row.path) ? '▸' : '▾'}</span>
							<span class="name">{row.name}</span>
						</button>
					{:else if row.path === relPath}
						<button class="active" aria-current="true" title={row.path} bind:this={activeItem}>
							<span class="caret"></span>
							<span class="name">{row.name}</span>
						</button>
					{:else}
						<button title={row.path} onclick={() => onpick(row.path)}>
							<span class="caret"></span>
							<span class="name">{row.name}</span>
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>
{/if}

<style>
	.files {
		width: 220px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.kinds {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 6px 8px 0;
	}
	.kinds button {
		flex: 1;
		font-size: 0.75rem;
		padding: 2px 6px;
	}
	.kinds button.on {
		border-color: var(--accent);
		color: var(--text-primary);
	}
	.head {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
	.head button {
		padding: 0 6px;
	}
	.count {
		margin-right: auto;
		padding-left: 4px;
	}
	.head label {
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	ul {
		flex: 1;
		overflow-y: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
	}
	li button {
		display: flex;
		align-items: baseline;
		gap: 4px;
		width: 100%;
		appearance: none;
		background: none;
		border: 0;
		border-radius: 4px;
		padding: 3px 6px 3px calc(6px + var(--depth) * 12px);
		text-align: left;
		font-size: 0.8rem;
		color: var(--text-primary);
		cursor: pointer;
	}
	li button:hover {
		background: var(--bg-secondary);
	}
	li button.active {
		background: var(--bg-secondary);
		box-shadow: inset 2px 0 0 var(--accent);
		cursor: default;
	}
	li button.dir {
		color: var(--text-secondary);
	}
	.caret {
		width: 0.8em;
		flex-shrink: 0;
		font-size: 0.7rem;
	}
	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
</style>
