<script lang="ts" module>
	import type { CameraAngle } from '#lib/editor/glbViewer.ts';

	/** Kept across models and tabs, so stepping through a folder compares like with like. */
	let lastAngle: CameraAngle | null = null;
	let showAttempts = false;
</script>

<script lang="ts">
	/**
	 * A `.glb` file in an editor window: the model, to orbit, with what is in
	 * it, and the other GLBs in the window's folder to step through. Read fresh
	 * on mount and on Reload; nothing here writes.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { mountGlbView, type GlbView } from '#lib/editor/glbViewer.ts';
	import { isAttempt, splitPath, stepModel, visibleModels } from '#lib/editor/glbList.ts';
	import type { GlbListing } from '#lib/ipc/gen/GlbListing.ts';

	let {
		workdir,
		relPath,
		onpick
	}: {
		workdir: string;
		relPath: string;
		/** Show another model from the list in place of this one. */
		onpick?: (relPath: string) => void;
	} = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let view: GlbView | null = $state.raw(null);
	let error = $state('');
	let loading = $state(true);
	/** The playing clip's index, as the select's value; '' is the rest pose. */
	let clip = $state('');
	let listing = $state.raw<GlbListing | null>(null);
	let attempts = $state(showAttempts);
	const models = $derived(listing ? visibleModels(listing.files, relPath, attempts) : []);
	const hasAttempts = $derived(listing?.files.some(isAttempt) ?? false);
	let activeItem: HTMLElement | undefined = $state();

	$effect(() => {
		// jsdom has no scrollIntoView.
		activeItem?.scrollIntoView?.({ block: 'nearest' });
	});

	function keepAngle(): void {
		if (view) lastAngle = view.angle();
	}

	async function list(): Promise<void> {
		if (!onpick) return;
		try {
			listing = await invoke<GlbListing>('editor_list_glb', { workdir });
		} catch (e) {
			console.warn('Listing models failed', e);
		}
	}

	async function load(): Promise<void> {
		if (!canvas) return;
		loading = true;
		error = '';
		keepAngle();
		view?.dispose();
		view = null;
		try {
			const bytes = await invoke<number[]>('fs_read_bytes', { workdir, relPath });
			view = await mountGlbView(canvas, new Uint8Array(bytes), lastAngle);
			clip = view.clips.length ? '0' : '';
		} catch (e) {
			error = `Could not show ${relPath}: ${e instanceof Error ? e.message : String(e)}`;
		}
		loading = false;
	}

	onMount(() => {
		void load();
		void list();
		return () => {
			keepAngle();
			view?.dispose();
		};
	});

	function step(delta: number): void {
		const next = stepModel(models, relPath, delta);
		if (next && onpick) onpick(next);
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

	const fmt = (n: number) => (Math.abs(n) >= 10 ? n.toFixed(1) : n.toFixed(2));
	const summary = $derived.by(() => {
		if (!view) return '';
		const s = view.stats;
		const parts = [
			`${s.meshes} ${s.meshes === 1 ? 'mesh' : 'meshes'}`,
			`${s.triangles.toLocaleString()} triangles`,
			`${s.size.map(fmt).join(' × ')} units`
		];
		return parts.join(' · ');
	});

	function pick(value: string): void {
		clip = value;
		view?.playClip(value === '' ? null : Number(value));
	}
</script>

<svelte:window onkeydown={onKeydown} />

<div class="glb-viewer" data-testid="glb-viewer">
	<div class="main">
		{#if models.length > 1}
			<nav class="models" aria-label="Models in this folder">
				<div class="models-head">
					<span title={listing?.truncated ? 'Only the first 2,000 are listed' : undefined}
						>{models.length}{listing?.truncated ? '+' : ''} models</span
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
				</div>
				<ul>
					{#each models as file (file)}
						{@const part = splitPath(file)}
						<li>
							{#if file === relPath}
								<button class="active" aria-current="true" title={file} bind:this={activeItem}>
									<span class="name">{part.name}</span>
									{#if part.dir}<span class="dir">{part.dir}</span>{/if}
								</button>
							{:else}
								<button title={file} onclick={() => onpick?.(file)}>
									<span class="name">{part.name}</span>
									{#if part.dir}<span class="dir">{part.dir}</span>{/if}
								</button>
							{/if}
						</li>
					{/each}
				</ul>
			</nav>
		{/if}
		<div class="stage">
			<canvas bind:this={canvas} class:hidden={!!error}></canvas>
			{#if loading}<p class="note">Loading…</p>{/if}
			{#if error}<p class="note error">{error}</p>{/if}
		</div>
	</div>
	<div class="bar">
		<span class="summary" title="Drag to orbit, scroll to zoom, right-drag to pan">{summary}</span>
		{#if view && view.clips.length}
			<select
				aria-label="Animation"
				title="Which animation plays"
				value={clip}
				onchange={(e) => pick(e.currentTarget.value)}
			>
				<option value="">Rest pose</option>
				{#each view.clips as name, i (i)}
					<option value={String(i)}>{name}</option>
				{/each}
			</select>
		{/if}
		{#if models.length > 1}
			<button onclick={() => step(-1)} title="Previous model (←)" aria-label="Previous model"
				>‹</button
			>
			<button onclick={() => step(1)} title="Next model (→)" aria-label="Next model">›</button>
		{/if}
		<button disabled={!view} onclick={() => view?.resetCamera()}>Reset view</button>
		<button
			disabled={loading}
			onclick={() => {
				void load();
				void list();
			}}>Reload</button
		>
	</div>
</div>

<style>
	.glb-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
	}
	.main {
		flex: 1;
		display: flex;
		gap: 8px;
		min-height: 0;
	}
	.models {
		width: 200px;
		flex-shrink: 0;
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	.models-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 6px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
	.models-head label {
		display: flex;
		align-items: center;
		gap: 4px;
		cursor: pointer;
	}
	.models ul {
		flex: 1;
		overflow-y: auto;
		margin: 0;
		padding: 4px;
		list-style: none;
	}
	.models li button {
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
	.models li button:hover {
		background: var(--bg-secondary);
	}
	.models li button.active {
		background: var(--bg-secondary);
		box-shadow: inset 2px 0 0 var(--accent);
		cursor: default;
	}
	.models .name,
	.models .dir {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.models .name {
		font-size: 0.8rem;
	}
	.models .dir {
		font-size: 0.7rem;
		color: var(--text-secondary);
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
	}
	canvas {
		display: block;
		width: 100%;
		height: 100%;
	}
	canvas.hidden {
		visibility: hidden;
	}
	.note {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		margin: 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}
	.note.error {
		color: var(--danger, #ef4444);
		padding: 16px;
	}
	.bar {
		display: flex;
		align-items: center;
		gap: 8px;
		padding-top: 6px;
	}
	.summary {
		margin-right: auto;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
