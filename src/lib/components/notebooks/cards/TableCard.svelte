<script lang="ts">
	/**
	 * A table card: typed columns, edited in place one cell at a time (each
	 * edit writes one row), with sorting, a filter, totals under number
	 * columns, and paste of several lines from a spreadsheet.
	 */
	import * as api from '#lib/notebooks/api.ts';
	import type { NotebookRow } from '#lib/notebooks/api.ts';
	import {
		COLUMN_TYPES,
		COLUMN_TYPE_LABELS,
		DEFAULT_STATUS,
		columnsOf,
		compare,
		defaultCurrency,
		formatCell,
		isValid,
		parseCell,
		rawCell,
		total,
		type Column,
		type ColumnType
	} from '#lib/notebooks/columns.ts';
	import { columnId, parseCsv } from '#lib/notebooks/csv.ts';
	import { applyRows, getLinkStatus, loadRows, setColumns } from '#lib/stores/notebooks.svelte.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';
	import { focusOnMount } from '#lib/utils/focusOnMount.ts';

	let { card, readonly = false }: CardViewProps = $props();

	const PAGE = 200;

	const columns = $derived(columnsOf(api.parseMeta(card.meta)));

	/** Rows past the first 200, read with "Show more". */
	let extra = $state<NotebookRow[]>([]);
	let loadedPast = $state(0);
	$effect(() => {
		// The card changed (a save): re-read any extra pages so they're current.
		void card.version;
		if (loadedPast === 0) {
			extra = [];
			return;
		}
		const want = loadedPast;
		void loadRows(card.id, PAGE, want)
			.then((r) => (extra = r))
			.catch((e) => console.warn('notebooks: reading more rows failed', e));
	});

	const allRows = $derived([...card.rows, ...extra]);
	const parsed = $derived(
		allRows.map((r) => ({ row: r, cells: api.parseMeta<Record<string, unknown>>(r.cells) }))
	);

	let filter = $state('');
	let sort = $state<{ col: string; dir: 1 | -1 } | null>(null);

	const shown = $derived.by(() => {
		const q = filter.trim().toLowerCase();
		let list = q
			? parsed.filter((p) =>
					columns.some((c) => formatCell(c, p.cells[c.id]).toLowerCase().includes(q))
				)
			: parsed;
		if (sort) {
			const c = columns.find((x) => x.id === sort!.col);
			const dir = sort.dir;
			if (c) list = [...list].sort((a, b) => dir * compare(c, a.cells[c.id], b.cells[c.id]));
		}
		return list;
	});

	const totals = $derived(
		columns.map((c) =>
			total(
				c,
				parsed.map((p) => p.cells[c.id])
			)
		)
	);
	const hasTotals = $derived(totals.some((t) => t !== null) && parsed.length > 1);

	// --- editing a cell ---
	let editing = $state<{ row: string; col: string } | null>(null);
	let draft = $state('');

	function startEdit(rowId: string, col: Column, value: unknown) {
		if (readonly) return;
		if (col.type === 'checkbox') {
			void writeCell(rowId, col, value === true ? 'false' : 'true');
			return;
		}
		editing = { row: rowId, col: col.id };
		draft = rawCell(value);
	}

	async function writeCell(rowId: string, col: Column, raw: string) {
		const p = parsed.find((x) => x.row.id === rowId);
		if (!p) return;
		const next = { ...p.cells };
		const value = parseCell(col, raw);
		if (value === '' || value === undefined) delete next[col.id];
		else next[col.id] = value;
		if (JSON.stringify(next) === p.row.cells) return;
		await applyRows(card, [{ op: 'update', row_id: rowId, cells: JSON.stringify(next) }]);
	}

	async function commit(move?: 'next' | 'down') {
		const e = editing;
		if (!e) return;
		const col = columns.find((c) => c.id === e.col);
		editing = null;
		if (col) await writeCell(e.row, col, draft);
		if (!move || !col) return;
		const ci = columns.findIndex((c) => c.id === e.col);
		const ri = shown.findIndex((s) => s.row.id === e.row);
		let nr = ri;
		let nc = ci;
		if (move === 'next') {
			nc = ci + 1;
			if (nc >= columns.length) {
				nc = 0;
				nr = ri + 1;
			}
		} else {
			nr = ri + 1;
		}
		const target = shown[nr];
		if (target && columns[nc]) startEdit(target.row.id, columns[nc], target.cells[columns[nc].id]);
	}

	/** Several lines pasted into a cell become rows after it. */
	function onPaste(e: ClipboardEvent, rowId: string) {
		const text = e.clipboardData?.getData('text/plain') ?? '';
		if (!/[\n\t]/.test(text.trim())) return;
		e.preventDefault();
		editing = null;
		const lines = text.includes('\t')
			? text
					.split(/\r?\n/)
					.filter((l) => l.trim())
					.map((l) => l.split('\t'))
			: parseCsv(text);
		const ops: api.RowOp[] = lines.map((fields) => {
			const cells: Record<string, unknown> = {};
			fields.forEach((f, i) => {
				const c = columns[i];
				if (c && f.trim() !== '') cells[c.id] = parseCell(c, f);
			});
			return { op: 'add', after: rowId, cells: JSON.stringify(cells) };
		});
		// Each lands right after the row, so add them last-first to keep
		// the pasted order.
		void applyRows(card, ops.reverse());
	}

	async function addRow() {
		await applyRows(card, [{ op: 'add', after: null, cells: '{}' }]);
	}

	async function deleteRow(rowId: string) {
		await applyRows(card, [{ op: 'delete', row_id: rowId }]);
	}

	// --- columns ---
	let colMenu = $state<string | null>(null);
	let renaming = $state<string | null>(null);
	let renameDraft = $state('');

	async function saveColumns(next: Column[]) {
		await setColumns(card, next);
	}

	async function addColumn() {
		const taken = new Set(columns.map((c) => c.id));
		const name = `Column ${columns.length + 1}`;
		await saveColumns([...columns, { id: columnId(name, taken), name, type: 'text' }]);
	}

	async function retype(col: Column, type: ColumnType) {
		colMenu = null;
		const next: Column = { ...col, type };
		if (type === 'currency' && !next.currency) next.currency = defaultCurrency();
		if (type === 'status' && !next.options) next.options = DEFAULT_STATUS;
		await saveColumns(columns.map((c) => (c.id === col.id ? next : c)));
		// Re-read the column's values under the new type; what doesn't parse
		// stays as text.
		const ops: api.RowOp[] = [];
		for (const p of parsed) {
			const v = p.cells[col.id];
			if (v === undefined) continue;
			const nv = parseCell(next, rawCell(v));
			if (nv !== v)
				ops.push({
					op: 'update',
					row_id: p.row.id,
					cells: JSON.stringify({ ...p.cells, [col.id]: nv })
				});
		}
		if (ops.length) await applyRows(card, ops);
	}

	async function rename(col: Column) {
		const name = renameDraft.trim();
		renaming = null;
		if (name && name !== col.name)
			await saveColumns(columns.map((c) => (c.id === col.id ? { ...c, name } : c)));
	}

	async function removeColumn(col: Column) {
		colMenu = null;
		if (!confirm(`Delete the column “${col.name}” and its values?`)) return;
		await saveColumns(columns.filter((c) => c.id !== col.id));
	}

	function sortBy(col: Column, dir: 1 | -1) {
		colMenu = null;
		sort = { col: col.id, dir };
	}

	async function moveColumn(col: Column, delta: -1 | 1) {
		colMenu = null;
		const i = columns.findIndex((c) => c.id === col.id);
		const j = i + delta;
		if (j < 0 || j >= columns.length) return;
		const next = [...columns];
		[next[i], next[j]] = [next[j], next[i]];
		await saveColumns(next);
	}

	async function showMore() {
		loadedPast += PAGE;
	}

	function isUrl(col: Column, v: unknown): v is string {
		return col.type === 'url' && typeof v === 'string' && /^https?:\/\//i.test(v);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (colMenu && e.key === 'Escape') colMenu = null;
	}}
/>

<div class="table-card">
	{#if parsed.length > 8 || filter}
		<input class="filter" bind:value={filter} placeholder="Filter rows" aria-label="Filter rows" />
	{/if}
	<div class="scroll">
		<table>
			<thead>
				<tr>
					{#each columns as col, ci (col.id)}
						<th>
							{#if renaming === col.id}
								<input
									class="col-name"
									bind:value={renameDraft}
									use:focusOnMount
									aria-label="Column name"
									onblur={() => void rename(col)}
									onkeydown={(e) => {
										if (e.key === 'Enter') void rename(col);
										if (e.key === 'Escape') renaming = null;
									}}
								/>
							{:else}
								<button
									class="col-head"
									disabled={readonly}
									onclick={() => (colMenu = colMenu === col.id ? null : col.id)}
									title="{COLUMN_TYPE_LABELS[col.type]} column"
								>
									{col.name}
									{#if sort?.col === col.id}<span class="arrow">
											{sort.dir === 1 ? '▲' : '▼'}
										</span>{/if}
								</button>
							{/if}
							{#if colMenu === col.id}
								<div class="menu" role="menu" aria-label="Column options">
									<button
										role="menuitem"
										onclick={() => {
											colMenu = null;
											renameDraft = col.name;
											renaming = col.id;
										}}
									>
										Rename
									</button>
									<button role="menuitem" onclick={() => sortBy(col, 1)}>Sort ascending</button>
									<button role="menuitem" onclick={() => sortBy(col, -1)}>Sort descending</button>
									{#if ci > 0}
										<button role="menuitem" onclick={() => void moveColumn(col, -1)}>
											Move left
										</button>
									{/if}
									{#if ci < columns.length - 1}
										<button role="menuitem" onclick={() => void moveColumn(col, 1)}>
											Move right
										</button>
									{/if}
									<div class="types" role="group" aria-label="Type">
										{#each COLUMN_TYPES as t (t)}
											<button
												role="menuitemradio"
												aria-checked={col.type === t}
												class:on={col.type === t}
												onclick={() => void retype(col, t)}
											>
												{COLUMN_TYPE_LABELS[t]}
											</button>
										{/each}
									</div>
									<button role="menuitem" class="danger" onclick={() => void removeColumn(col)}>
										Delete column
									</button>
								</div>
							{/if}
						</th>
					{/each}
					{#if !readonly}
						<th class="add-col">
							<button class="mini" onclick={() => void addColumn()} title="Add a column">+</button>
						</th>
					{/if}
				</tr>
			</thead>
			<tbody>
				{#each shown as { row, cells } (row.id)}
					<tr id="nb-row-{row.id}">
						{#each columns as col (col.id)}
							{@const v = cells[col.id]}
							<td
								class:invalid={!isValid(col, v)}
								class:num={col.type === 'number' || col.type === 'currency'}
								title={!isValid(col, v)
									? `Not a ${COLUMN_TYPE_LABELS[col.type].toLowerCase()}`
									: undefined}
							>
								{#if editing?.row === row.id && editing.col === col.id}
									{#if col.type === 'status'}
										<select
											bind:value={draft}
											use:focusOnMount
											aria-label={col.name}
											onchange={() => void commit()}
											onblur={() => void commit()}
										>
											<option value=""></option>
											{#each col.options ?? DEFAULT_STATUS as o (o)}
												<option value={o}>{o}</option>
											{/each}
										</select>
									{:else}
										<input
											class="cell-input"
											bind:value={draft}
											use:focusOnMount
											aria-label={col.name}
											type={col.type === 'date' ? 'date' : 'text'}
											onblur={() => void commit()}
											onpaste={(e) => onPaste(e, row.id)}
											onkeydown={(e) => {
												if (e.key === 'Enter') {
													e.preventDefault();
													void commit('down');
												} else if (e.key === 'Tab') {
													e.preventDefault();
													void commit('next');
												} else if (e.key === 'Escape') {
													editing = null;
												}
											}}
										/>
									{/if}
								{:else if isUrl(col, v)}
									<span class="cell-wrap">
										<a
											class:link-broken={getLinkStatus(v)?.state === 'broken'}
											href={v}
											target="_blank"
											rel="noopener noreferrer"
										>
											{v.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')}
										</a>
										{#if getLinkStatus(v)?.state === 'broken'}
											<span class="broken" title="Broken link: {getLinkStatus(v)?.status}">⚠</span>
										{/if}
										{#if !readonly}
											<button
												class="edit-url"
												aria-label="Edit link"
												onclick={() => startEdit(row.id, col, v)}
											>
												✎
											</button>
										{/if}
									</span>
								{:else}
									<button
										class="cell"
										class:check={col.type === 'checkbox'}
										disabled={readonly}
										onclick={() => startEdit(row.id, col, v)}
									>
										{formatCell(col, v) || ' '}
									</button>
								{/if}
							</td>
						{/each}
						{#if !readonly}
							<td class="row-actions">
								<button
									class="mini"
									aria-label="Delete row"
									title="Delete row"
									onclick={() => void deleteRow(row.id)}
								>
									×
								</button>
							</td>
						{/if}
					</tr>
				{/each}
			</tbody>
			{#if hasTotals}
				<tfoot>
					<tr>
						{#each columns as col, i (col.id)}
							<td class:num={totals[i] !== null}>
								{totals[i] !== null ? formatCell(col, totals[i]) : i === 0 ? 'Total' : ''}
							</td>
						{/each}
					</tr>
				</tfoot>
			{/if}
		</table>
	</div>
	<div class="foot">
		{#if !readonly}
			<button class="mini wide" onclick={() => void addRow()}>+ Row</button>
		{/if}
		{#if allRows.length < card.row_count}
			<button class="mini wide" onclick={() => void showMore()}>
				Show more ({card.row_count - allRows.length} left)
			</button>
		{/if}
		<span class="count">{card.row_count} {card.row_count === 1 ? 'row' : 'rows'}</span>
	</div>
</div>

<style>
	.table-card {
		font-size: 0.88rem;
	}

	.filter {
		margin-bottom: 6px;
		width: 220px;
		padding: 4px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}

	.scroll {
		overflow-x: auto;
	}

	table {
		border-collapse: collapse;
		min-width: 100%;
	}

	th,
	td {
		border: 1px solid var(--border);
		padding: 0;
		text-align: left;
		vertical-align: top;
	}

	th {
		position: relative;
		background: var(--bg-primary);
		font-weight: 600;
	}

	.col-head {
		width: 100%;
		text-align: left;
		border: none;
		background: none;
		color: var(--text-primary);
		font: inherit;
		font-weight: 600;
		padding: 5px 8px;
		cursor: pointer;
		white-space: nowrap;
	}

	.col-head:disabled {
		cursor: default;
	}

	.arrow {
		font-size: 0.65rem;
		margin-left: 4px;
		color: var(--text-secondary);
	}

	.col-name,
	.cell-input,
	select {
		width: 100%;
		min-width: 80px;
		box-sizing: border-box;
		border: none;
		outline: 2px solid var(--accent);
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		padding: 5px 8px;
	}

	.cell {
		display: block;
		width: 100%;
		min-height: 1.9em;
		text-align: inherit;
		border: none;
		background: none;
		color: var(--text-primary);
		font: inherit;
		padding: 5px 8px;
		cursor: text;
		white-space: pre-wrap;
		word-break: break-word;
	}

	.cell.check {
		text-align: center;
		cursor: pointer;
	}

	.cell:disabled {
		cursor: default;
	}

	.cell-wrap {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 5px 8px;
	}

	.edit-url {
		opacity: 0;
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0 2px;
	}

	td:hover .edit-url {
		opacity: 1;
	}

	.num {
		text-align: right;
	}

	td.invalid {
		background: color-mix(in srgb, var(--warning) 14%, transparent);
	}

	tfoot td {
		padding: 5px 8px;
		font-weight: 600;
		background: var(--bg-primary);
	}

	.add-col,
	.row-actions {
		width: 1%;
		border: none;
		background: none;
	}

	.mini {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 6px;
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.row-actions .mini {
		opacity: 0;
	}

	tr:hover .row-actions .mini {
		opacity: 1;
	}

	.mini:hover {
		color: var(--accent);
		background: var(--bg-primary);
	}

	.foot {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 4px;
	}

	.count {
		margin-left: auto;
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.menu {
		position: absolute;
		top: 100%;
		left: 0;
		z-index: 30;
		display: flex;
		flex-direction: column;
		min-width: 160px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-weight: normal;
	}

	.menu > button,
	.types button {
		text-align: left;
		padding: 5px 10px;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.82rem;
	}

	.menu > button:hover,
	.types button:hover {
		background: var(--bg-primary);
	}

	.types {
		display: grid;
		grid-template-columns: 1fr 1fr;
		border-top: 1px solid var(--border);
		border-bottom: 1px solid var(--border);
	}

	.types button.on {
		color: var(--accent);
		font-weight: 600;
	}

	.danger:hover {
		color: var(--error-text);
	}

	.broken {
		color: var(--warning);
		cursor: help;
	}
</style>
