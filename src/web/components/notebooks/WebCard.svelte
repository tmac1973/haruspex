<script lang="ts">
	/**
	 * One notebook card on the web: text (shown, or edited in a text box),
	 * a table (a grid, or a card per row on a phone; tap a cell to change
	 * it), a checklist to tick. Python, files and pictures are shown only.
	 */
	import { renderMarkdown } from '#lib/markdown.ts';
	import * as api from '#lib/notebooks/api.ts';
	import type { NotebookCard } from '#lib/notebooks/api.ts';
	import {
		columnsOf,
		formatCell,
		parseCell,
		rawCell,
		type Column
	} from '#lib/notebooks/columns.ts';
	import { outputOf } from '#lib/notebooks/pythonOutput.ts';
	import type { WebNotebooks } from '../../notebooks.svelte.ts';

	let { card, nb }: { card: NotebookCard; nb: WebNotebooks } = $props();

	let editing = $state(false);
	let draft = $state('');
	let cell = $state<{ row: string; col: string; value: string } | null>(null);

	const cols = $derived(columnsOf(api.parseMeta(card.meta)));
	const rows = $derived(
		card.rows.map((r) => ({ id: r.id, cells: api.parseMeta<Record<string, unknown>>(r.cells) }))
	);
	const file = $derived(api.parseMeta<{ hash?: string; name?: string; size?: number }>(card.meta));
	const output = $derived(card.kind === 'python' ? outputOf(card) : null);

	function editText() {
		draft = card.body;
		editing = true;
	}

	async function saveText() {
		if (await nb.updateCard(card, { body: draft })) editing = false;
	}

	async function saveCell(col: Column) {
		const c = cell;
		cell = null;
		const row = rows.find((r) => r.id === c?.row);
		if (!c || !row) return;
		const next = { ...row.cells };
		const v = parseCell(col, c.value);
		if (v === '' || v === undefined) delete next[col.id];
		else next[col.id] = v;
		await nb.applyRows(card, [{ op: 'update', row_id: row.id, cells: JSON.stringify(next) }]);
	}

	async function toggle(rowId: string, cells: Record<string, unknown>) {
		await nb.applyRows(card, [
			{ op: 'update', row_id: rowId, cells: JSON.stringify({ ...cells, done: !cells.done }) }
		]);
	}

	async function addRow() {
		await nb.applyRows(card, [
			{
				op: 'add',
				after: null,
				cells: card.kind === 'checklist' ? JSON.stringify({ text: '', done: false }) : '{}'
			}
		]);
	}
</script>

<section class="card" id="web-card-{card.id}">
	<header>
		<h3>{card.title || ' '}</h3>
		{#if card.kind === 'text' || card.kind === 'table' || card.kind === 'checklist'}
			<button class="mini" title="Delete card" onclick={() => void nb.deleteCard(card)}>🗑</button>
		{/if}
	</header>
	{#if card.kind === 'text'}
		{#if editing}
			<textarea bind:value={draft} rows="8" aria-label="Card text"></textarea>
			<div class="actions">
				<button onclick={() => (editing = false)}>Cancel</button>
				<button class="primary" onclick={() => void saveText()}>Save</button>
			</div>
		{:else}
			<div class="markdown">{@html renderMarkdown(card.body || '*Empty*')}</div>
			<div class="actions"><button onclick={editText}>Edit</button></div>
		{/if}
	{:else if card.kind === 'table'}
		<div class="rows">
			{#each rows as r (r.id)}
				<div class="row">
					{#each cols as c (c.id)}
						<div class="field">
							<span class="label">{c.name}</span>
							{#if cell?.row === r.id && cell.col === c.id}
								<input
									bind:value={cell.value}
									aria-label={c.name}
									onblur={() => void saveCell(c)}
									onkeydown={(e) => {
										if (e.key === 'Enter') void saveCell(c);
										if (e.key === 'Escape') cell = null;
									}}
								/>
							{:else}
								<button
									class="value"
									onclick={() => (cell = { row: r.id, col: c.id, value: rawCell(r.cells[c.id]) })}
								>
									{formatCell(c, r.cells[c.id]) || '—'}
								</button>
							{/if}
						</div>
					{/each}
				</div>
			{/each}
		</div>
		{#if card.row_count > card.rows.length}
			<p class="hint">{card.row_count - card.rows.length} more rows on your computer.</p>
		{/if}
		<div class="actions"><button onclick={() => void addRow()}>+ Row</button></div>
	{:else if card.kind === 'checklist'}
		<ul class="check">
			{#each rows as r (r.id)}
				<li>
					<label>
						<input
							type="checkbox"
							checked={r.cells.done === true}
							onchange={() => void toggle(r.id, r.cells)}
						/>
						<span class:done={r.cells.done === true}>{String(r.cells.text ?? '')}</span>
					</label>
					{#if typeof r.cells.note === 'string' && r.cells.note}
						<p class="note">{r.cells.note}</p>
					{/if}
				</li>
			{/each}
		</ul>
	{:else if card.kind === 'python'}
		<pre class="code">{card.body}</pre>
		{#if output?.stdout}<pre>{output.stdout}</pre>{/if}
		{#each output?.artifacts ?? [] as a, i (i)}
			{#if a.kind === 'image'}<img src={a.dataUrl} alt={a.alt ?? 'plot'} />{/if}
		{/each}
		<p class="hint">Open on the desktop to change this.</p>
	{:else if card.kind === 'image' && file.hash}
		<img src={api.fileUrl(file.hash)} alt={card.title || file.name || 'Picture'} />
	{:else}
		<p>📎 {file.name ?? 'File'} <span class="hint">Open on the desktop to change this.</span></p>
	{/if}
</section>

<style>
	.card {
		margin: 0 0 10px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
	}

	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}

	h3 {
		margin: 0 0 6px;
		font-size: 0.95rem;
	}

	.mini {
		border: none;
		background: none;
		cursor: pointer;
		opacity: 0.6;
	}

	textarea,
	input:not([type='checkbox']) {
		width: 100%;
		box-sizing: border-box;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.actions {
		display: flex;
		justify-content: flex-end;
		gap: 6px;
		margin-top: 6px;
	}

	.actions button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text-primary);
		padding: 4px 10px;
		cursor: pointer;
	}

	.actions .primary {
		border: none;
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.rows {
		display: grid;
		gap: 6px;
	}

	.row {
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(120px, 1fr));
		gap: 4px 10px;
		padding: 6px 0;
		border-bottom: 1px solid var(--border);
	}

	.field {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.label {
		color: var(--text-muted);
		font-size: 0.72rem;
	}

	.value {
		text-align: left;
		border: none;
		background: none;
		color: var(--text-primary);
		padding: 2px 0;
		cursor: text;
		word-break: break-word;
	}

	.check {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.check li {
		padding: 3px 0;
	}

	.check .note {
		margin: 2px 0 0 24px;
		color: var(--text-muted);
		font-size: 0.85rem;
		white-space: pre-wrap;
	}

	.done {
		color: var(--text-muted);
		text-decoration: line-through;
	}

	pre {
		white-space: pre-wrap;
		font-size: 0.8rem;
	}

	.code {
		background: var(--bg-primary);
		padding: 6px;
		border-radius: 4px;
	}

	img {
		max-width: 100%;
		border-radius: 6px;
	}

	.hint {
		color: var(--text-muted);
		font-size: 0.8rem;
	}
</style>
