<script lang="ts" module>
	/** Kept across tabs and windows: whether the job's earlier tries are listed. */
	let showAttempts = false;
</script>

<script lang="ts">
	/**
	 * Beside a viewer tab: the other files of its kind under the window's
	 * folder, to step through with ← / → or a click, and a switch to the
	 * other kinds the folder holds. Hidden while there is nothing else to show.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { viewerFor } from '#lib/editor/document.svelte.ts';
	import {
		KINDS,
		countKinds,
		isAttempt,
		splitPath,
		stepFile,
		visibleFiles
	} from '#lib/editor/viewerList.ts';
	import type { ViewableListing } from '#lib/ipc/gen/ViewableListing.ts';

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

	let listing = $state.raw<ViewableListing | null>(null);
	let attempts = $state(showAttempts);
	const kind = $derived(viewerFor(relPath));
	const files = $derived(
		listing && kind ? visibleFiles(listing.files, relPath, kind, attempts) : []
	);
	const counts = $derived(listing ? countKinds(listing.files, attempts) : new Map());
	const kinds = $derived(KINDS.filter((k) => k.kind === kind || counts.has(k.kind)));
	const hasAttempts = $derived(listing?.files.some(isAttempt) ?? false);
	const shown = $derived(files.length > 1 || kinds.length > 1);
	let activeItem: HTMLElement | undefined = $state();

	$effect(() => {
		// jsdom has no scrollIntoView.
		activeItem?.scrollIntoView?.({ block: 'nearest' });
	});

	async function refresh(): Promise<void> {
		try {
			listing = await invoke<ViewableListing>('editor_list_viewable', { workdir });
		} catch (e) {
			console.warn('Listing files failed', e);
		}
	}

	onMount(() => void refresh());

	function step(delta: number): void {
		const next = stepFile(files, relPath, delta);
		if (next) onpick(next);
	}

	function switchTo(to: string): void {
		if (to === kind || !listing) return;
		const first = listing.files.find((f) => viewerFor(f) === to && (attempts || !isAttempt(f)));
		if (first) onpick(first);
	}

	function onKeydown(e: KeyboardEvent): void {
		if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey || e.defaultPrevented) return;
		if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
		const t = e.target;
		if (t instanceof Element && t.closest('input, select, textarea, [contenteditable]')) return;
		e.preventDefault();
		step(e.key === 'ArrowRight' ? 1 : -1);
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
			<button onclick={() => step(-1)} title="Previous (←)" aria-label="Previous">‹</button>
			<button onclick={() => step(1)} title="Next (→)" aria-label="Next">›</button>
			<span class="count" title={listing?.truncated ? 'Only the first 2,000 are listed' : undefined}
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
			{#each files as file (file)}
				{@const part = splitPath(file)}
				<li>
					{#if file === relPath}
						<button class="active" aria-current="true" title={file} bind:this={activeItem}>
							<span class="name">{part.name}</span>
							{#if part.dir}<span class="dir">{part.dir}</span>{/if}
						</button>
					{:else}
						<button title={file} onclick={() => onpick(file)}>
							<span class="name">{part.name}</span>
							{#if part.dir}<span class="dir">{part.dir}</span>{/if}
						</button>
					{/if}
				</li>
			{/each}
		</ul>
	</nav>
{/if}

<style>
	.files {
		width: 200px;
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
		flex-direction: column;
		width: 100%;
		appearance: none;
		background: none;
		border: 0;
		border-radius: 4px;
		padding: 4px 6px;
		text-align: left;
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
	.name,
	.dir {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name {
		font-size: 0.8rem;
	}
	.dir {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}
</style>
