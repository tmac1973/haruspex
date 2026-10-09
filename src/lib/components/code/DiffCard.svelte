<script lang="ts">
	/**
	 * A file edit or write as a unified diff. Long diffs show their first
	 * lines until expanded.
	 */
	import type { DiffRow, FileDiff } from '#lib/code/diff.ts';

	let { diff }: { diff: FileDiff } = $props();

	/** Rows shown before "Show all". */
	const PREVIEW_ROWS = 40;

	let expanded = $state(false);
	const rows = $derived<DiffRow[]>(expanded ? diff.rows : diff.rows.slice(0, PREVIEW_ROWS));
	const hidden = $derived(diff.rows.length - rows.length);

	const verb = $derived(
		diff.mode === 'new' ? 'Created' : diff.mode === 'write' ? 'Wrote' : 'Edited'
	);
</script>

<div class="card" data-testid="diff-card">
	<div class="head">
		<span class="verb">{verb}</span>
		<code class="path" title={diff.path}>{diff.path}</code>
		<span class="add">+{diff.added}</span>
		<span class="del">−{diff.removed}</span>
	</div>
	{#if diff.rows.length > 0}
		<div class="body">
			{#each rows as row, i (i)}
				{#if row.kind === 'gap'}
					<div class="gap">⋯ {row.skipped} unchanged line{row.skipped === 1 ? '' : 's'}</div>
				{:else}
					<div class="line {row.kind}">
						<span class="no">{row.oldNo ?? ''}</span>
						<span class="no">{row.newNo ?? ''}</span>
						<span class="sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '}</span>
						<span class="text">{row.text}</span>
					</div>
				{/if}
			{/each}
		</div>
		{#if hidden > 0}
			<button class="more" onclick={() => (expanded = true)}
				>Show all {diff.rows.length} lines</button
			>
		{:else if diff.truncated}
			<div class="gap">The rest of this diff isn't kept.</div>
		{/if}
	{:else if diff.mode !== 'new'}
		<div class="gap">No changes.</div>
	{/if}
</div>

<style>
	.card {
		margin: 6px 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--code-bg);
		color: #e8e3d9;
		overflow: hidden;
		font-size: 0.8rem;
	}

	.head {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 6px 10px;
	}

	.verb {
		color: #a39d92;
		font-size: 0.74rem;
	}

	.path {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		background: none;
		color: inherit;
	}

	.add {
		color: #6fae6a;
		font-size: 0.74rem;
	}

	.del {
		color: #dd6b60;
		font-size: 0.74rem;
	}

	.body {
		border-top: 1px solid #2a2621;
		max-height: 520px;
		overflow: auto;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		font-size: 0.74rem;
		line-height: 1.45;
	}

	.line {
		display: flex;
		white-space: pre;
		min-width: max-content;
	}

	.line.add {
		background: rgba(111, 174, 106, 0.16);
	}

	.line.del {
		background: rgba(221, 107, 96, 0.16);
	}

	.no {
		flex: 0 0 3.2em;
		padding-right: 6px;
		text-align: right;
		color: #6f6a61;
		user-select: none;
	}

	.sign {
		flex: 0 0 1.4em;
		text-align: center;
		user-select: none;
	}

	.line.add .sign {
		color: #6fae6a;
	}

	.line.del .sign {
		color: #dd6b60;
	}

	.text {
		padding-right: 12px;
	}

	.gap {
		padding: 2px 10px;
		color: #6f6a61;
		font-size: 0.7rem;
		background: #16140f;
	}

	.more {
		display: block;
		width: 100%;
		appearance: none;
		background: #16140f;
		border: 0;
		border-top: 1px solid #2a2621;
		color: #4fb0a5;
		font-size: 0.72rem;
		padding: 3px;
		cursor: pointer;
	}
</style>
