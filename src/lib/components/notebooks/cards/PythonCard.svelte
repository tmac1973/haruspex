<script lang="ts">
	/**
	 * A Python card: code run in the notebook's sandbox, with the notebook's
	 * tables as pandas DataFrames (`tables["Title"]`, `table("Title")`), and
	 * the last run's output kept. Output reads "stale" once a table it read
	 * has changed. A DataFrame left in `result` can become a table card.
	 */
	import { onDestroy, untrack } from 'svelte';
	import { createEditor, type EditorHandle } from '#lib/editor/codemirror.ts';
	import ArtifactFrame from '#lib/components/ArtifactFrame.svelte';
	import { openImageViewer } from '#lib/stores/imageViewer.svelte.ts';
	import { addCard, getOpenNotebook, saveCard } from '#lib/stores/notebooks.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { cancelRun, resetSandbox } from '#lib/sandbox/sandbox.ts';
	import {
		isStale,
		outputOf,
		pythonUnavailable,
		runPythonCard,
		sandboxIdFor,
		withOutput
	} from '#lib/notebooks/pythonRun.ts';
	import { rowsFromCsv } from '#lib/notebooks/csv.ts';
	import { columnsOf } from '#lib/notebooks/columns.ts';
	import { parseMeta } from '#lib/notebooks/api.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card, readonly = false }: CardViewProps = $props();

	let host = $state<HTMLDivElement | null>(null);
	let editor: EditorHandle | null = null;
	let draft = '';
	let timer: ReturnType<typeof setTimeout> | null = null;
	let running = $state(false);

	const output = $derived(outputOf(card));
	const stale = $derived(!!output && isStale(output, getOpenNotebook()?.cards ?? []));
	const unavailable = $derived(pythonUnavailable());

	async function flush(): Promise<typeof card> {
		if (timer) clearTimeout(timer);
		timer = null;
		if (draft === card.body) return card;
		return (await saveCard(card, { body: draft })) ?? card;
	}

	$effect(() => {
		if (!host) return;
		// Made once per mount: a save changing card.body must not rebuild it.
		const body = untrack(() => card.body);
		draft = body;
		editor = createEditor(host, {
			path: 'card.py',
			doc: body,
			readonly: untrack(() => readonly),
			onChange(value) {
				draft = value;
				if (timer) clearTimeout(timer);
				timer = setTimeout(() => void flush(), 1000);
			},
			onSave: () => void run()
		});
		return () => {
			editor?.destroy();
			editor = null;
		};
	});

	// A change from elsewhere (an agent, History) reaches an editor not
	// being typed in.
	$effect(() => {
		const body = card.body;
		if (editor && !timer && editor.getValue() !== body) {
			editor.setValue(body);
			draft = body;
		}
	});

	async function run() {
		if (running || readonly) return;
		running = true;
		try {
			const current = await flush();
			const out = await runPythonCard(current, getOpenNotebook()?.cards ?? [], draft);
			await saveCard(current, { meta: withOutput(current, out) });
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		} finally {
			running = false;
		}
	}

	function stop() {
		cancelRun(sandboxIdFor(card.notebook_id));
	}

	async function reset() {
		await resetSandbox(sandboxIdFor(card.notebook_id));
		showToast("This notebook's Python variables were cleared.", { kind: 'info' });
	}

	async function saveAsTable() {
		const csv = output?.result_csv;
		if (!csv) return;
		// Columns named like the notebook's keep their types (a price stays currency).
		const known = (getOpenNotebook()?.cards ?? [])
			.filter((c) => c.kind === 'table')
			.flatMap((c) => columnsOf(parseMeta(c.meta)));
		const byName = known.filter(
			(c, i) => known.findIndex((k) => k.name.toLowerCase() === c.name.toLowerCase()) === i
		);
		const t = rowsFromCsv(csv, byName);
		await addCard(
			{
				kind: 'table',
				title: `${card.title || 'Python'} result`,
				body: '',
				meta: JSON.stringify({ columns: t.columns }),
				rows: t.rows.map((r) => JSON.stringify(r))
			},
			card.id,
			{ kind: 'python', ref: card.id, label: card.title || 'Python card' }
		);
	}

	onDestroy(() => {
		if (timer) {
			clearTimeout(timer);
			void flush();
		}
	});
</script>

<div class="editor" bind:this={host}></div>
{#if !readonly}
	<div class="bar">
		{#if running}
			<button class="run" onclick={stop}>Stop</button>
			<span class="hint">Running…</span>
		{:else}
			<button
				class="run"
				onclick={() => void run()}
				disabled={!!unavailable}
				title={unavailable ?? 'Run (Ctrl / ⌘ + S)'}
			>
				▶ Run
			</button>
		{/if}
		<button
			class="mini"
			onclick={() => void reset()}
			title="Clear the variables this notebook's Python cards have made"
		>
			Reset
		</button>
		{#if stale}
			<span class="stale" title="A table this read has changed since it ran">stale</span>
		{/if}
		{#if !output}
			<span class="hint">
				Tables are in <code>tables["Title"]</code>; put a DataFrame in <code>result</code> to save it
				as a table.
			</span>
		{/if}
	</div>
{/if}
{#if output}
	<div class="output" class:stale>
		{#if output.stdout}<pre>{output.stdout}</pre>{/if}
		{#if output.result && output.result !== 'None' && !output.result_csv}<pre>{output.result}</pre>{/if}
		{#if output.stderr}<pre class="err">{output.stderr}</pre>{/if}
		{#if output.error}<pre class="err">{output.error}</pre>{/if}
		{#each output.artifacts as a, i (i)}
			{#if a.kind === 'image'}
				<button
					class="pic"
					onclick={() => openImageViewer([{ src: a.dataUrl, alt: a.alt ?? 'plot' }])}
				>
					<img src={a.dataUrl} alt={a.alt ?? 'plot'} />
				</button>
			{:else if a.kind === 'html' && a.interactive}
				<ArtifactFrame html={a.html} />
			{:else if a.kind === 'html'}
				<div class="html markdown">{@html a.html}</div>
			{/if}
		{/each}
		{#each output.notes as n, i (i)}<p class="hint">{n}</p>{/each}
		<div class="foot">
			<span class="hint">
				Ran {new Date(output.ran_at).toLocaleString()} · {output.duration_ms} ms
			</span>
			{#if output.result_csv && !readonly}
				<button class="mini" onclick={() => void saveAsTable()}>Save as table card</button>
			{/if}
		</div>
	</div>
{/if}

<style>
	.editor {
		min-height: 60px;
		max-height: 50vh;
		overflow: auto;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
	}

	.bar,
	.foot {
		display: flex;
		align-items: center;
		gap: 8px;
		margin-top: 6px;
		flex-wrap: wrap;
	}

	.run {
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		padding: 4px 12px;
		font-size: 0.82rem;
	}

	.run:disabled {
		opacity: 0.5;
		cursor: default;
	}

	.mini {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 2px 6px;
		font-size: 0.8rem;
	}

	.mini:hover {
		color: var(--accent);
	}

	.hint {
		color: var(--text-muted);
		font-size: 0.78rem;
	}

	.stale {
		border: 1px solid var(--warning);
		border-radius: 10px;
		color: var(--warning);
		font-size: 0.72rem;
		padding: 0 6px;
	}

	.output {
		margin-top: 8px;
		padding: 8px;
		border-radius: 6px;
		background: var(--bg-primary);
	}

	.output.stale {
		opacity: 0.75;
	}

	pre {
		margin: 0 0 6px;
		white-space: pre-wrap;
		word-break: break-word;
		font-size: 0.8rem;
	}

	pre.err {
		color: var(--error-text);
	}

	.pic {
		display: block;
		padding: 0;
		border: none;
		background: none;
		cursor: zoom-in;
	}

	.pic img {
		max-width: 100%;
		border-radius: 4px;
	}

	.html {
		overflow-x: auto;
		font-size: 0.8rem;
	}

	.foot {
		justify-content: space-between;
	}
</style>
