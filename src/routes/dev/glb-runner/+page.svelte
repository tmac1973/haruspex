<script lang="ts">
	/**
	 * Dev builds only: run a 3D specialist's HTML through the headless runner
	 * and the GLB check (report and render sheet) by hand, for the per-OS test of
	 * `#lib/specialists/three/`. Renders nothing in a release build.
	 */
	import { runAssetHtml, type AssetRunResult } from '#lib/specialists/three/runHtml.ts';
	import { snapshotProblems } from '#lib/specialists/three/snapshot.ts';
	import { checkGlb, type GlbCheck } from '#lib/glb/check.ts';
	import { extractHtml } from '#lib/specialists/three/extract.ts';
	import { runBuildModule, type ModuleRunResult } from '#lib/helpers/three/runModule.ts';

	const dev = import.meta.env.DEV;

	let html = $state('');
	let doExport = $state(true);
	let running = $state(false);
	let elapsed = $state<number | null>(null);
	let result = $state<AssetRunResult | null>(null);
	let snapProblems = $state<string[]>([]);
	let checked = $state<GlbCheck | { problems: string[] } | null>(null);
	let failure = $state<string | null>(null);
	let controller: AbortController | null = null;

	let moduleSource = $state('');
	let moduleRunning = $state(false);
	let moduleResult = $state<ModuleRunResult | null>(null);
	let moduleChecked = $state<GlbCheck | { problems: string[] } | null>(null);
	/** The clip shown moving, or '' for the still sheet. */
	let moduleClip = $state('');
	const moduleClips = $derived(
		moduleChecked && 'report' in moduleChecked
			? moduleChecked.report.animations.map((a) => a.name)
			: []
	);

	async function showClip(clip: string) {
		moduleClip = clip;
		if (moduleResult?.glb)
			moduleChecked = await checkGlb(moduleResult.glb, { clip: clip || undefined });
	}

	async function runModule() {
		moduleRunning = true;
		moduleResult = null;
		moduleChecked = null;
		moduleClip = '';
		try {
			moduleResult = await runBuildModule(moduleSource);
			if (moduleResult.glb) moduleChecked = await checkGlb(moduleResult.glb);
		} catch (e) {
			failure = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
		} finally {
			moduleRunning = false;
		}
	}

	async function loadFile(e: Event) {
		const file = (e.currentTarget as HTMLInputElement).files?.[0];
		if (file) html = await file.text();
	}

	async function run() {
		running = true;
		result = null;
		checked = null;
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
			if (r.glb) checked = await checkGlb(r.glb);
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

		<h2>Build module</h2>
		<div class="row">
			<button
				type="button"
				class="run"
				onclick={runModule}
				disabled={moduleRunning || !moduleSource.trim()}>Run module</button
			>
			{#if moduleRunning}<span>Running…</span>{/if}
		</div>
		<textarea
			bind:value={moduleSource}
			spellcheck="false"
			placeholder="export default function build(THREE, kit) … "></textarea>
		{#if moduleResult}
			<ul class="errors">
				{#each moduleResult.errors as e, i (i)}
					<li>[{e.kind}] {e.line !== null ? `line ${e.line}: ` : ''}{e.message}</li>
				{/each}
			</ul>
			{#if moduleResult.glb}<p>GLB: {moduleResult.glb.byteLength} bytes</p>{/if}
			{#if moduleChecked && 'problems' in moduleChecked}
				<ul class="errors">
					{#each moduleChecked.problems as p, i (i)}<li>{p}</li>{/each}
				</ul>
			{:else if moduleChecked}
				{#if moduleClips.length}
					<label
						>Clip <select value={moduleClip} onchange={(e) => void showClip(e.currentTarget.value)}>
							<option value="">Still sheet</option>
							{#each moduleClips as name (name)}<option value={name}>{name}</option>{/each}
						</select></label
					>
				{/if}
				<pre class="stats">{moduleChecked.text}</pre>
				{#if moduleChecked.png}<img
						class="render"
						src={moduleChecked.png}
						alt="Module render sheet"
					/>{/if}
			{/if}
		{/if}

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
				{#if checked && 'problems' in checked}
					<ul class="errors">
						{#each checked.problems as p, i (i)}<li>{p}</li>{/each}
					</ul>
				{:else if checked}
					<pre class="stats">{checked.text}</pre>
					{#if checked.png}<img class="render" src={checked.png} alt="GLB render sheet" />{/if}
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
		max-width: 1200px;
		border: 1px solid var(--border);
	}
</style>
