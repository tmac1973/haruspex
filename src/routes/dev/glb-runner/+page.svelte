<script lang="ts">
	/**
	 * Dev builds only: run a 3D specialist's HTML through the headless runner
	 * and the GLB preview by hand, for the per-OS test of
	 * `#lib/specialists/three/`. Renders nothing in a release build.
	 */
	import { runAssetHtml, type AssetRunResult } from '#lib/specialists/three/runHtml.ts';
	import { snapshotProblems } from '#lib/specialists/three/snapshot.ts';
	import { previewGlb, type GlbPreview } from '#lib/specialists/three/preview.ts';
	import { extractHtml } from '#lib/specialists/three/extract.ts';

	const dev = import.meta.env.DEV;

	let html = $state('');
	let doExport = $state(true);
	let running = $state(false);
	let elapsed = $state<number | null>(null);
	let result = $state<AssetRunResult | null>(null);
	let snapProblems = $state<string[]>([]);
	let preview = $state<GlbPreview | null>(null);
	let failure = $state<string | null>(null);
	let controller: AbortController | null = null;

	async function loadFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (file) html = await file.text();
	}

	async function run() {
		running = true;
		result = null;
		preview = null;
		snapProblems = [];
		failure = null;
		elapsed = null;
		controller = new AbortController();
		const t0 = performance.now();
		try {
			const r = await runAssetHtml(extractHtml(html) ?? html, {
				signal: controller.signal,
				export: doExport
			});
			elapsed = Math.round(performance.now() - t0);
			result = r;
			if (r.png) snapProblems = await snapshotProblems(r.png);
			if (r.glb) preview = await previewGlb(r.glb);
		} catch (e) {
			failure = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		} finally {
			running = false;
			controller = null;
		}
	}
</script>

{#if dev}
	<div class="runner">
		<h1>GLB runner</h1>
		<div class="row">
			<input type="file" accept=".html,text/html" onchange={loadFile} />
			<label><input type="checkbox" bind:checked={doExport} /> Export GLB</label>
			<button type="button" class="run" onclick={run} disabled={running || !html.trim()}>Run</button
			>
			<button type="button" onclick={() => controller?.abort()} disabled={!running}>Cancel</button>
			{#if running}<span>Running…</span>{/if}
			{#if elapsed !== null}<span class="elapsed">{elapsed} ms</span>{/if}
		</div>
		<textarea bind:value={html} spellcheck="false" placeholder="Paste the HTML here"></textarea>

		{#if failure}<p class="failure">{failure}</p>{/if}

		{#if result}
			<h2>Errors ({result.errors.length})</h2>
			<ul class="errors">
				{#each result.errors as e, i (i)}
					<li>[{e.kind}] {e.line !== null ? `line ${e.line}: ` : ''}{e.message}</li>
				{/each}
			</ul>

			<h2>Snapshot</h2>
			{#if result.png}
				<p class="snap-problems">
					{snapProblems.length ? snapProblems.join(' ') : 'Not blank.'}
				</p>
				<img class="snapshot" src={result.png} alt="snapshot" />
			{:else}
				<p>No snapshot.</p>
			{/if}

			{#if result.glb}
				<h2>GLB ({result.glb.byteLength} bytes)</h2>
				{#if preview}
					<pre class="stats">{JSON.stringify(
							{
								ok: preview.ok,
								problems: preview.problems,
								meshes: preview.meshes,
								triangles: preview.triangles,
								animations: preview.animations,
								size: preview.size.map((n) => +n.toFixed(3))
							},
							null,
							2
						)}</pre>
					{#if preview.png}<img class="render" src={preview.png} alt="GLB render" />{/if}
				{/if}
			{:else if doExport}
				<p>No GLB.</p>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.runner {
		padding: 16px;
		overflow: auto;
		height: 100%;
		box-sizing: border-box;
	}
	.row {
		display: flex;
		gap: 12px;
		align-items: center;
		flex-wrap: wrap;
	}
	textarea {
		width: 100%;
		height: 160px;
		margin-top: 8px;
		font-family: monospace;
		font-size: 0.75rem;
	}
	.failure,
	.errors {
		color: var(--error-text, #c97);
	}
	.snapshot,
	.render {
		max-width: 640px;
		border: 1px solid var(--border);
	}
</style>
