<script lang="ts">
	/**
	 * Settings → Notebooks: the notebook chat's step limit, semantic search,
	 * and backing up and restoring every notebook. Semantic search downloads the embedding model Memory
	 * uses (once), then indexes notebooks in the background.
	 */
	import { onMount } from 'svelte';
	import {
		getSettings,
		updateSettings,
		MIN_CHAT_MAX_ITERATIONS,
		MAX_CHAT_MAX_ITERATIONS
	} from '#lib/stores/settings.ts';
	import { clampInt } from '#lib/utils/clampInt.ts';
	import {
		downloadModel,
		getModelError,
		getModelStatus,
		refreshModelStatus
	} from '#lib/stores/memory.svelte.ts';
	import { getIndexPending, indexNow } from '#lib/notebooks/indexer.svelte.ts';
	import {
		backUpNotebooks,
		describeCounts,
		describeRestore,
		pickBackup,
		restoreBackup,
		type NotebookBackupInfo,
		type NotebookRestoreMode
	} from '#lib/notebooks/backup.ts';
	import { reloadAllNotebooks } from '#lib/stores/notebooks.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let on = $state(getSettings().notebooks.semanticSearch);
	let maxSteps = $state(getSettings().notebooks.chatMaxIterations);

	function persistMaxSteps() {
		maxSteps = clampInt(maxSteps, MIN_CHAT_MAX_ITERATIONS, MAX_CHAT_MAX_ITERATIONS);
		updateSettings({ notebooks: { ...getSettings().notebooks, chatMaxIterations: maxSteps } });
	}
	const status = $derived(getModelStatus());
	const error = $derived(getModelError());

	onMount(() => {
		void refreshModelStatus();
		if (on) void indexNow();
	});

	async function toggle(next: boolean) {
		on = next;
		updateSettings({ notebooks: { ...getSettings().notebooks, semanticSearch: next } });
		if (!next) return;
		if (getModelStatus() !== 'ready') await downloadModel();
		void indexNow();
	}

	let busy = $state(false);
	let picked = $state<{ path: string; info: NotebookBackupInfo } | null>(null);

	async function backUp() {
		busy = true;
		try {
			const counts = await backUpNotebooks();
			if (counts) showToast(`Backed up ${describeCounts(counts)}.`, { kind: 'success' });
		} catch (e) {
			showToast(`The backup failed: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			busy = false;
		}
	}

	async function choose() {
		busy = true;
		try {
			picked = await pickBackup();
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		} finally {
			busy = false;
		}
	}

	async function restore(mode: NotebookRestoreMode) {
		if (!picked) return;
		if (
			mode === 'replace' &&
			!confirm(
				'Replace your notebooks with the backup? Notebooks not in it move to Trash, and the ones in it lose changes made since. A copy of what is here now is saved first.'
			)
		)
			return;
		busy = true;
		try {
			const result = await restoreBackup(picked.path, mode);
			picked = null;
			await reloadAllNotebooks();
			if (on) void indexNow();
			let text = describeRestore(result);
			if (result.saved_before) text += ` What was here is saved in ${result.saved_before}.`;
			showToast(text, { kind: result.missing_files ? 'error' : 'success' });
		} catch (e) {
			showToast(`The restore failed: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			busy = false;
		}
	}
</script>

<section class="settings-section">
	<h2>Max steps per turn</h2>
	<label
		class="tokens-row"
		title="Each tool call or model reply is a step. Raise it if the notebook chat stops before it has written everything. Settings → Chat has its own limit. {MIN_CHAT_MAX_ITERATIONS}–{MAX_CHAT_MAX_ITERATIONS}."
	>
		<span class="tokens-label">
			Notebook chat steps
			<span class="tokens-sub">
				How many steps a notebook chat turn takes before it has to answer.
			</span>
		</span>
		<input
			type="number"
			min={MIN_CHAT_MAX_ITERATIONS}
			max={MAX_CHAT_MAX_ITERATIONS}
			step="5"
			bind:value={maxSteps}
			onblur={persistMaxSteps}
			onkeydown={(e) => e.key === 'Enter' && persistMaxSteps()}
		/>
	</label>
</section>

<section class="settings-section">
	<h2>Search</h2>
	<label
		class="toggle-row"
		title="Finds cards by what they mean, not only the words in them. Downloads the 65 MB model Memory uses, once; notebooks are indexed on this computer."
	>
		<input type="checkbox" checked={on} onchange={(e) => void toggle(e.currentTarget.checked)} />
		<div>
			<strong>Semantic search</strong>
			<span>Find notebook cards by meaning as well as by words.</span>
		</div>
	</label>
	{#if on}
		{#if status === 'downloading'}
			<p class="hint">Downloading the model…</p>
		{:else if status === 'error'}
			<p class="hint error">The model didn't download: {error}</p>
		{:else if getIndexPending() > 0}
			<p class="hint">Indexing {getIndexPending()} cards…</p>
		{/if}
	{/if}
</section>

<section class="settings-section">
	<h2>Backup</h2>
	<p class="lede">Save every notebook, with its files and history, to one file.</p>
	<div class="actions">
		<button
			class="btn"
			onclick={() => void backUp()}
			disabled={busy}
			title="Notebooks in Trash and earlier card versions are included; notebook chats aren't."
		>
			Back up…
		</button>
		<button class="btn" onclick={() => void choose()} disabled={busy}>Restore…</button>
	</div>
	{#if picked}
		{@const info = picked.info}
		<div class="restore">
			<p>
				Backup from {new Date(info.created_at).toLocaleString()}: {describeCounts(info.counts)}.
				{#if info.already_here}
					{info.already_here === info.counts.notebooks ? 'All' : info.already_here} of its notebooks are
					here already.
				{/if}
			</p>
			<div class="actions">
				<button
					class="btn btn-primary"
					onclick={() => void restore('add')}
					disabled={busy}
					title="Notebooks already here are left as they are."
				>
					{info.already_here ? 'Add the missing ones' : 'Restore'}
				</button>
				{#if info.already_here}
					<button
						class="btn btn-danger"
						onclick={() => void restore('replace')}
						disabled={busy}
						title="The backup's notebooks replace the ones here; notebooks not in it move to Trash. What is here now is saved to a file first."
					>
						Replace with the backup
					</button>
				{/if}
				<button class="btn" onclick={() => (picked = null)} disabled={busy}>Cancel</button>
			</div>
		</div>
	{/if}
</section>

<style>
	.tokens-row {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 16px;
	}

	.tokens-label {
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.tokens-sub {
		display: block;
		font-size: 0.7rem;
		color: var(--text-secondary);
		margin-top: 2px;
		max-width: 46ch;
	}

	.tokens-row input {
		flex-shrink: 0;
		width: 9ch;
		padding: 6px 8px;
		font-size: 0.85rem;
		font-variant-numeric: tabular-nums;
		text-align: right;
		color: var(--text-primary);
		background: var(--surface);
		border: 1px solid var(--border);
		border-radius: 6px;
	}

	.tokens-row input:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 1px;
	}

	.lede {
		margin: 0 0 10px;
		color: var(--text-secondary);
		font-size: 0.9rem;
	}

	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}

	.restore {
		margin-top: 12px;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
	}

	.restore p {
		margin: 0 0 10px;
		font-size: 0.9rem;
	}

	.hint {
		margin: 6px 0 0;
		color: var(--text-secondary);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error-text);
	}
</style>
