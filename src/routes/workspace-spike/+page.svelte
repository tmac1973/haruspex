<script lang="ts">
	// Temporary spike route for phase-13 unified python sandbox.
	// Two modes:
	//   - 'spike'    → embeds static/workspace/spike.html (step-1 verification)
	//   - 'manager'  → drives the production iframe via IframeManager (step 3)
	// Delete once the production UI lands.

	import { onDestroy } from 'svelte';
	import { IframeManager } from '$lib/workspace/iframe-manager';

	let mode: 'spike' | 'manager' = $state('manager');
	let mountTarget: HTMLDivElement | null = $state(null);
	let logLines: string[] = $state([]);
	let manager: IframeManager | null = null;
	let stageWrites = $state(0);
	let stageClears = $state(0);
	let snapshotPng = $state<string | null>(null);

	function log(line: string): void {
		logLines = [...logLines, line];
	}

	function ensureManager(): IframeManager {
		if (!mountTarget) throw new Error('mount target not bound yet');
		if (!manager) {
			manager = new IframeManager({
				onStageWrite: () => {
					stageWrites++;
					log('[stage_write]');
				},
				onStageClear: () => {
					stageClears++;
					log('[stage_clear]');
				}
			});
			manager.attach(mountTarget);
		}
		return manager;
	}

	async function runDemo(label: string, code: string): Promise<void> {
		try {
			const m = ensureManager();
			log(`> ${label}`);
			const r = await m.runPython(code, {
				onStdout: (s) => log('OUT ' + s.trimEnd()),
				onStderr: (s) => log('ERR ' + s.trimEnd())
			});
			log(`done: result=${r.result || '(none)'} artifacts=${r.artifacts} took=${r.duration_ms}ms`);
			if (r.error) log(`ERROR: ${r.error}`);
			if (r.artifactsList.length) {
				for (const a of r.artifactsList) {
					if (a.kind === 'image') log(`  artifact image: ${a.mime} (${a.dataUrl.length} chars)`);
					else log(`  artifact html: ${a.html.slice(0, 60)}…`);
				}
			}
		} catch (err) {
			log('exception: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function doMath(): Promise<void> {
		await runDemo('math', `print("hello"); 2 + 2`);
	}

	async function doMatplotlib(): Promise<void> {
		await runDemo(
			'matplotlib',
			`
import matplotlib.pyplot as plt
plt.figure()
plt.plot([1,2,3,4], [1,4,9,16])
plt.title("squares")
plt.show()
"plotted"
`
		);
	}

	async function doShowHtml(): Promise<void> {
		await runDemo(
			'show_html',
			`
import haruspex
haruspex.show_html("<h1 style='color:#cf6'>Hello from haruspex.show_html</h1><p>plain HTML — script-tag re-exec is verified via plotly in step 4.</p>")
"rendered"
`
		);
	}

	async function doPandasDataFrame(): Promise<void> {
		await runDemo(
			'dataframe',
			`
import pandas as pd
pd.DataFrame({"a": [1,2,3], "b": [4,5,6]})
`
		);
	}

	async function doPygame(): Promise<void> {
		await runDemo(
			'pygame',
			`
import asyncio, pygame, haruspex
pygame.init()
screen = pygame.display.set_mode((480, 320))
clock = pygame.time.Clock()
x, y, vx, vy = 240, 160, 3, 2
async def main():
    while True:
        for ev in pygame.event.get():
            if ev.type == pygame.KEYDOWN:
                print(f"key={pygame.key.name(ev.key)}")
        globals().__setitem__('x', x + vx)
        globals().__setitem__('y', y + vy)
        if x < 20 or x > 460: globals().__setitem__('vx', -vx)
        if y < 20 or y > 300: globals().__setitem__('vy', -vy)
        screen.fill((20, 20, 30))
        pygame.draw.circle(screen, (180, 120, 220), (x, y), 20)
        pygame.display.flip(); clock.tick(30)
        await asyncio.sleep(0)
haruspex.spawn(main())
"launched"
`
		);
	}

	async function doStopTasks(): Promise<void> {
		await runDemo('stop_tasks', `import haruspex; haruspex.stop_tasks()`);
	}

	async function doClearStage(): Promise<void> {
		await runDemo('clear_stage', `import haruspex; haruspex.clear_stage()`);
	}

	async function doSnapshot(): Promise<void> {
		try {
			const m = ensureManager();
			const snap = await m.captureSnapshot();
			log(`snapshot: ${snap.mime}, ${snap.payload.length} chars`);
			snapshotPng = snap.mime === 'image/png' ? snap.payload : null;
		} catch (err) {
			log('snapshot failed: ' + (err instanceof Error ? err.message : String(err)));
		}
	}

	async function doReset(): Promise<void> {
		if (!manager) return;
		await manager.reset();
		log('[reset]');
	}

	onDestroy(() => {
		manager?.reset();
		manager = null;
	});
</script>

<div class="page">
	<header>
		<h1>Workspace spike</h1>
		<div class="modes">
			<label>
				<input type="radio" bind:group={mode} value="manager" />
				manager (production iframe + IframeManager)
			</label>
			<label>
				<input type="radio" bind:group={mode} value="spike" />
				raw iframe → /workspace/spike.html (step 1)
			</label>
		</div>
	</header>

	{#if mode === 'manager'}
		<div class="manager-pane">
			<div class="controls">
				<button onclick={doMath}>2 + 2 / print</button>
				<button onclick={doMatplotlib}>matplotlib → artifact</button>
				<button onclick={doPandasDataFrame}>DataFrame → artifact</button>
				<button onclick={doShowHtml}>haruspex.show_html</button>
				<button onclick={doPygame}>pygame (haruspex.spawn)</button>
				<button onclick={doStopTasks}>haruspex.stop_tasks</button>
				<button onclick={doClearStage}>haruspex.clear_stage</button>
				<button onclick={doSnapshot}>captureSnapshot()</button>
				<button onclick={doReset}>reset (respawn iframe)</button>
			</div>
			<div class="stage" bind:this={mountTarget}></div>
			<div class="counters">
				stage_write={stageWrites} · stage_clear={stageClears}
			</div>
			<div class="log">
				{#each logLines as line, i (i)}
					<div>{line}</div>
				{/each}
			</div>
			{#if snapshotPng}
				<div class="snap">
					<div class="snap-label">last canvas snapshot:</div>
					<img alt="canvas snapshot" src={snapshotPng} />
				</div>
			{/if}
		</div>
	{:else}
		<iframe src="/workspace/spike.html" title="workspace-spike-static"></iframe>
	{/if}
</div>

<style>
	.page {
		padding: 1rem;
		color: #ddd;
		font-family: system-ui, sans-serif;
	}
	header {
		margin-bottom: 1rem;
	}
	h1 {
		margin: 0 0 0.5rem;
		font-size: 1.1rem;
	}
	.modes {
		display: flex;
		gap: 1rem;
		flex-wrap: wrap;
		font-size: 0.85rem;
	}
	.manager-pane {
		display: grid;
		grid-template-columns: 1fr;
		gap: 0.5rem;
	}
	.controls {
		display: flex;
		gap: 0.5rem;
		flex-wrap: wrap;
	}
	button {
		background: #2a2a2a;
		color: #ddd;
		border: 1px solid #444;
		padding: 0.4rem 0.8rem;
		font-family: inherit;
		cursor: pointer;
	}
	button:hover {
		background: #333;
	}
	.stage {
		height: 360px;
		background: #1a1a1a;
		border: 1px solid #444;
		overflow: hidden;
	}
	.counters {
		font-size: 0.8rem;
		color: #aaa;
	}
	.log {
		background: #0d0d0d;
		border: 1px solid #333;
		padding: 0.5rem;
		font-family: ui-monospace, monospace;
		font-size: 0.8rem;
		max-height: 220px;
		overflow-y: auto;
	}
	.snap img {
		max-width: 320px;
		border: 1px solid #444;
		margin-top: 0.25rem;
	}
	.snap-label {
		font-size: 0.8rem;
		color: #aaa;
	}
	iframe {
		width: 100%;
		height: 600px;
		border: 1px solid #444;
		background: #1a1a1a;
	}
</style>
