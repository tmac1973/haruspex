<script lang="ts">
	/**
	 * An attachment card: a file kept with the notebook. Open hands a copy to
	 * the app the system uses for it; Save a copy… writes one where you choose;
	 * Replace… swaps in another file (the old one stays in History).
	 */
	import { open } from '@tauri-apps/plugin-dialog';
	import * as api from '#lib/notebooks/api.ts';
	import { fileMeta, formatSize, openFileCard, saveFileCopy } from '#lib/notebooks/files.ts';
	import { getOpenBackend, saveCard } from '#lib/stores/notebooks.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import type { CardViewProps } from '#lib/notebooks/cardKinds.ts';

	let { card, readonly = false }: CardViewProps = $props();

	const file = $derived(fileMeta(card));
	const local = $derived(getOpenBackend().kind === 'local');
	const isPdf = $derived(local && file?.mime === 'application/pdf');

	let preview = $state<string | null>(null);
	let previewing = $state(false);

	function icon(mime: string): string {
		if (mime === 'application/pdf') return '📕';
		if (mime.startsWith('image/')) return '🖼';
		if (mime.startsWith('audio/')) return '🎵';
		if (mime.startsWith('video/')) return '🎬';
		if (/sheet|excel|csv/.test(mime)) return '📊';
		if (/word|document|text/.test(mime)) return '📄';
		if (/zip/.test(mime)) return '🗜';
		return '📎';
	}

	async function togglePreview() {
		if (preview) {
			preview = null;
			return;
		}
		if (!file) return;
		previewing = true;
		try {
			const bytes = new Uint8Array(await (await fetch(api.fileUrl(file.hash))).arrayBuffer());
			const { previewPdf } = await import('#lib/documents/preview.ts');
			preview = (await previewPdf(bytes))?.sheets[0] ?? null;
			if (!preview) showToast('No preview for this PDF.', { kind: 'info' });
		} catch (e) {
			showToast(`No preview: ${errMessage(e)}`, { kind: 'error' });
		} finally {
			previewing = false;
		}
	}

	async function replace() {
		const picked = await open({ multiple: false });
		if (!picked || Array.isArray(picked)) return;
		try {
			const next = await api.storeFilePath(picked);
			await saveCard(card, { meta: JSON.stringify(next) });
			preview = null;
		} catch (e) {
			showToast(errMessage(e), { kind: 'error' });
		}
	}
</script>

{#if file}
	<div class="file">
		<span class="icon" aria-hidden="true">{icon(file.mime)}</span>
		<div class="info">
			<span class="name">{file.name}</span>
			<span class="size">{formatSize(file.size)}</span>
		</div>
		<div class="actions">
			{#if local}
				<button
					onclick={() => void openFileCard(file)}
					title="Open it in the app your computer uses for this type"
				>
					Open
				</button>
			{/if}
			<button
				onclick={() => void saveFileCopy(file, getOpenBackend())}
				title={local ? undefined : 'Files over 25 MB stay on the other computer'}
			>
				Save a copy…
			</button>
			{#if isPdf}
				<button onclick={() => void togglePreview()} disabled={previewing}>
					{preview ? 'Hide preview' : previewing ? 'Drawing…' : 'Preview'}
				</button>
			{/if}
			{#if !readonly && local}
				<button
					onclick={() => void replace()}
					title="Put another file here; the old one stays in History"
				>
					Replace…
				</button>
			{/if}
		</div>
	</div>
	{#if preview}
		<img class="preview" src={preview} alt="First pages of {file.name}" />
	{/if}
{:else}
	<p class="missing">This file's details are missing.</p>
{/if}

<style>
	.file {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
	}

	.icon {
		font-size: 1.6rem;
	}

	.info {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.size,
	.missing {
		color: var(--text-muted);
		font-size: 0.8rem;
	}

	.actions {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.actions button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text-primary);
		cursor: pointer;
		padding: 3px 10px;
		font-size: 0.8rem;
	}

	.actions button:hover:not(:disabled) {
		border-color: var(--accent);
	}

	.preview {
		display: block;
		max-width: 100%;
		margin-top: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
	}
</style>
