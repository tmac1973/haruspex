<script lang="ts">
	/**
	 * A `.glb` file in an editor window: the model, to orbit, with what is in
	 * it. Read fresh on mount and on Reload; nothing here writes.
	 */
	import { onMount } from 'svelte';
	import { invoke } from '@tauri-apps/api/core';
	import { mountGlbView, type GlbView } from '#lib/editor/glbViewer.ts';

	let { workdir, relPath }: { workdir: string; relPath: string } = $props();

	let canvas: HTMLCanvasElement | undefined = $state();
	let view: GlbView | null = $state.raw(null);
	let error = $state('');
	let loading = $state(true);
	/** The playing clip's index, as the select's value; '' is the rest pose. */
	let clip = $state('');

	async function load(): Promise<void> {
		if (!canvas) return;
		loading = true;
		error = '';
		view?.dispose();
		view = null;
		try {
			const bytes = await invoke<number[]>('fs_read_bytes', { workdir, relPath });
			view = await mountGlbView(canvas, new Uint8Array(bytes));
			clip = view.clips.length ? '0' : '';
		} catch (e) {
			error = `Could not show ${relPath}: ${e instanceof Error ? e.message : String(e)}`;
		}
		loading = false;
	}

	onMount(() => {
		void load();
		return () => view?.dispose();
	});

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

<div class="glb-viewer" data-testid="glb-viewer">
	<div class="stage">
		<canvas bind:this={canvas} class:hidden={!!error}></canvas>
		{#if loading}<p class="note">Loading…</p>{/if}
		{#if error}<p class="note error">{error}</p>{/if}
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
		<button disabled={!view} onclick={() => view?.resetCamera()}>Reset view</button>
		<button disabled={loading} onclick={() => void load()}>Reload</button>
	</div>
</div>

<style>
	.glb-viewer {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-height: 0;
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
