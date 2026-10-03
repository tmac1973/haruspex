<script lang="ts">
	import { untrack } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import Modal from '$lib/components/Modal.svelte';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { parseAssetSpec } from '$lib/assets/spec/parse';
	import { renderAssetSpec } from '$lib/assets/spec/write';
	import type { AssetEntry, AssetSpec } from '$lib/assets/spec/types';
	import { enqueue } from '$lib/agent/jobs/runner.svelte';
	import { regenerateMarked, type ReviewMark } from './review';

	// Look through a finished set and send the ones you do not like back.
	let {
		open,
		jobId,
		workingDir,
		specPath,
		onclose
	}: {
		open: boolean;
		jobId: number;
		workingDir: string;
		specPath: string;
		onclose: () => void;
	} = $props();

	interface Tile {
		entry: AssetEntry;
		url: string | null;
	}

	let spec = $state<AssetSpec | null>(null);
	let tiles = $state<Tile[]>([]);
	let error = $state('');
	let busy = $state(false);
	/** Marked ids, with the note for each. */
	let marks = $state<Record<string, string>>({});
	const markedCount = $derived(Object.keys(marks).length);

	async function load() {
		error = '';
		marks = {};
		for (const t of tiles) if (t.url) URL.revokeObjectURL(t.url);
		tiles = [];
		try {
			const text = await invoke<string>('fs_read_text_full', {
				workdir: workingDir,
				relPath: specPath
			});
			const parsed = parseAssetSpec(text);
			if ('errors' in parsed) {
				error = parsed.errors[0];
				return;
			}
			spec = parsed.spec;
			tiles = await Promise.all(
				parsed.spec.entries.map(async (entry) => {
					try {
						const bytes = await invoke<number[]>('fs_read_bytes', {
							workdir: workingDir,
							relPath: entry.out
						});
						const blob = new Blob([new Uint8Array(bytes)], { type: 'image/png' });
						return { entry, url: URL.createObjectURL(blob) };
					} catch {
						return { entry, url: null };
					}
				})
			);
		} catch (e) {
			error = `Could not read ${specPath}: ${e instanceof Error ? e.message : String(e)}`;
		}
	}

	// On open only. `load` reads the tiles it replaces (to release their URLs);
	// tracked, that made this effect re-run every time the images arrived,
	// emptying the grid again — the dialog showed nothing.
	$effect(() => {
		if (open) untrack(() => void load());
	});

	function toggle(id: string) {
		if (id in marks) {
			const next = { ...marks };
			delete next[id];
			marks = next;
		} else {
			marks = { ...marks, [id]: '' };
		}
	}

	async function regenerate() {
		if (!spec || markedCount === 0) return;
		busy = true;
		error = '';
		const chosen: ReviewMark[] = Object.entries(marks).map(([id, note]) => ({ id, note }));
		try {
			await regenerateMarked(spec, chosen, {
				exists: (relPath) => invoke<boolean>('fs_path_exists', { workdir: workingDir, relPath }),
				move: (fromRel, toRel) =>
					invoke('fs_move_in_workdir', { workdir: workingDir, fromRel, toRel }),
				writeSpec: (s) =>
					invoke('fs_write_text', {
						workdir: workingDir,
						relPath: specPath,
						content: renderAssetSpec(s),
						overwrite: true
					}),
				run: () => enqueue(jobId, 'manual')
			});
			onclose();
		} catch (e) {
			error = e instanceof Error ? e.message : String(e);
		} finally {
			busy = false;
		}
	}
</script>

<Modal {open} maxWidth={880} title="Review assets" dismissable {onclose}>
	<p class="help">
		Click the ones to make again.
		<Tooltip
			label="About reviewing assets"
			text="Each one you mark is moved to a .history folder beside it, so nothing is lost, and the job is run again: it makes only what is missing, drawn beside finished assets of the same group so they match. A note is added to that asset's prompt in the spec, and stays there."
		/>
	</p>
	{#if error}<p class="warn">{error}</p>{/if}
	<div class="grid">
		{#each tiles as t (t.entry.id)}
			{@const marked = t.entry.id in marks}
			<div class="tile" class:marked>
				<button
					type="button"
					class="pick"
					onclick={() => toggle(t.entry.id)}
					aria-pressed={marked}
					title={t.entry.prompt}
				>
					{#if t.url}
						<img src={t.url} alt={t.entry.id} />
					{:else}
						<span class="missing">not made</span>
					{/if}
					<span class="name">{t.entry.id}</span>
				</button>
				{#if marked}
					<input
						type="text"
						placeholder="what to change (optional)"
						bind:value={marks[t.entry.id]}
						aria-label={`Note for ${t.entry.id}`}
					/>
				{/if}
			</div>
		{/each}
	</div>
	<div class="actions">
		<button onclick={onclose} disabled={busy}>Cancel</button>
		<button class="primary" onclick={regenerate} disabled={busy || markedCount === 0}>
			{busy ? 'Starting…' : `Make ${markedCount || ''} again`}
		</button>
	</div>
</Modal>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(112px, 1fr));
		gap: 10px;
		max-height: 60vh;
		overflow-y: auto;
		margin: 10px 0;
	}

	.tile {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.pick {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 6px;
		border: 2px solid transparent;
		border-radius: 6px;
		background: none;
		cursor: pointer;
	}

	.tile.marked .pick {
		border-color: var(--accent, #6a7dff);
	}

	/* A checkerboard, so transparency reads as transparency. */
	img,
	.missing {
		width: 96px;
		height: 96px;
		background-color: #d9d9d9;
		background-image:
			linear-gradient(45deg, #bbb 25%, transparent 25%),
			linear-gradient(-45deg, #bbb 25%, transparent 25%),
			linear-gradient(45deg, transparent 75%, #bbb 75%),
			linear-gradient(-45deg, transparent 75%, #bbb 75%);
		background-size: 12px 12px;
		background-position:
			0 0,
			0 6px,
			6px -6px,
			-6px 0;
		image-rendering: pixelated;
		object-fit: contain;
	}

	.missing {
		display: flex;
		align-items: center;
		justify-content: center;
		font-size: 0.8em;
		color: #555;
	}

	.name {
		font-size: 0.8em;
		word-break: break-all;
	}

	.tile input {
		width: 100%;
		font-size: 0.8em;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}
</style>
