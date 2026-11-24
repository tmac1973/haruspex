<script lang="ts">
	/**
	 * A card's History: its earlier versions, newest first, each the card as
	 * it was before a change. Pick one to see it; Restore puts it back (and
	 * the version replaced becomes a History entry of its own).
	 */
	import * as api from '#lib/notebooks/api.ts';
	import type { CardHistoryEntry, NotebookCard } from '#lib/notebooks/api.ts';
	import { cardKind } from '#lib/notebooks/cardKinds.ts';
	import { describeSource } from '#lib/notebooks/source.ts';
	import { getOpenBackend, restoreRevision } from '#lib/stores/notebooks.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		card: NotebookCard;
		onclose: () => void;
	}

	let { card, onclose }: Props = $props();

	let entries = $state<CardHistoryEntry[]>([]);
	let loading = $state(true);
	let picked = $state<number | null>(null);
	let preview = $state<NotebookCard | null>(null);

	$effect(() => {
		const id = card.id;
		loading = true;
		void getOpenBackend()
			.history(id)
			.then((list) => (entries = list))
			.catch((e) => showToast(`History failed: ${errMessage(e)}`, { kind: 'error' }))
			.finally(() => (loading = false));
	});

	async function pick(entry: CardHistoryEntry) {
		picked = entry.id;
		// Another computer's versions are restored there, not previewed here.
		if (!getOpenBackend().can.preview) return;
		try {
			const snap = await api.cardRevision(entry.id);
			preview = {
				...card,
				title: snap.title,
				body: snap.body,
				meta: snap.meta,
				rows: snap.rows.slice(0, 200),
				row_count: snap.rows.length,
				version: -1
			};
		} catch (e) {
			showToast(`That version can't be read: ${errMessage(e)}`, { kind: 'error' });
		}
	}

	async function restore() {
		if (picked === null) return;
		const entry = entries.find((e) => e.id === picked);
		if (await restoreRevision(card.id, picked)) {
			showToast(
				`Restored the version from ${entry ? new Date(entry.created_at).toLocaleString() : 'then'}.`,
				{ kind: 'success' }
			);
			onclose();
		}
	}

	const def = $derived(cardKind(card.kind));
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape') onclose();
	}}
/>

<div class="backdrop" role="presentation" onclick={onclose}></div>
<div class="dialog" role="dialog" aria-label="Card history" aria-modal="true">
	<header>
		<h3>History — {card.title || 'Untitled'}</h3>
		<button class="close" onclick={onclose} aria-label="Close">×</button>
	</header>
	<div class="body">
		<ul class="list">
			{#if loading}
				<li class="hint">Loading…</li>
			{:else if entries.length === 0}
				<li class="hint">No earlier versions yet.</li>
			{/if}
			{#each entries as e (e.id)}
				<li>
					<button class:on={picked === e.id} onclick={() => void pick(e)}>
						<span class="when">{new Date(e.created_at).toLocaleString()}</span>
						<span class="who" title="The change that replaced this version">
							before: {describeSource(api.parseSource(e.source))}
						</span>
					</button>
				</li>
			{/each}
		</ul>
		<div class="preview">
			{#if preview && def}
				<h4>{preview.title || 'Untitled'}</h4>
				<def.component card={preview} readonly />
			{:else}
				<p class="hint">
					{getOpenBackend().can.preview
						? 'Pick a version to see it.'
						: `Pick a version to restore; it's kept on ${getOpenBackend().peerName}.`}
				</p>
			{/if}
		</div>
	</div>
	<footer>
		<button class="primary" disabled={picked === null} onclick={() => void restore()}>
			Restore this version
		</button>
	</footer>
</div>

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgb(0 0 0 / 45%);
	}

	.dialog {
		position: fixed;
		z-index: 101;
		top: 8vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(900px, 92vw);
		max-height: 84vh;
		display: flex;
		flex-direction: column;
		border: 1px solid var(--border);
		border-radius: 10px;
		background: var(--bg-primary);
	}

	header,
	footer {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 14px;
	}

	header {
		border-bottom: 1px solid var(--border);
	}

	footer {
		justify-content: flex-end;
		border-top: 1px solid var(--border);
	}

	h3 {
		margin: 0;
		font-size: 1rem;
	}

	h4 {
		margin: 0 0 8px;
	}

	.close {
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 1.3rem;
		cursor: pointer;
	}

	.body {
		display: flex;
		min-height: 0;
		flex: 1;
	}

	.list {
		list-style: none;
		margin: 0;
		padding: 6px;
		width: 260px;
		flex-shrink: 0;
		overflow-y: auto;
		border-right: 1px solid var(--border);
	}

	.list button {
		display: flex;
		flex-direction: column;
		width: 100%;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		padding: 6px 8px;
	}

	.list button:hover {
		background: var(--bg-secondary);
	}

	.list button.on {
		background: var(--accent-soft);
	}

	.when {
		font-size: 0.85rem;
	}

	.who {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.preview {
		flex: 1;
		min-width: 0;
		overflow: auto;
		padding: 12px 16px;
	}

	.hint {
		color: var(--text-muted);
		font-size: 0.85rem;
		padding: 6px 8px;
	}

	.primary {
		border: none;
		border-radius: 6px;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		padding: 6px 14px;
	}

	.primary:disabled {
		opacity: 0.5;
		cursor: default;
	}
</style>
