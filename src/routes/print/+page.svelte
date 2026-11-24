<script lang="ts">
	/**
	 * A print window (`print-<id>`, opened by Rust's `print_open`): the
	 * document on a white page, and a toolbar the printout leaves out. It
	 * opens the print dialog once the pictures have loaded; Print opens it
	 * again. The root layout treats it as detached, so it runs none of the
	 * app's bootstrap.
	 */
	import { onMount, tick } from 'svelte';
	import { page } from '$app/state';
	import { invoke } from '@tauri-apps/api/core';
	import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
	import type { PrintDoc } from '#lib/ipc/gen/PrintDoc.ts';
	import { sanitizeHtml } from '#lib/sanitize.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let doc = $state<PrintDoc | null>(null);
	let missing = $state(false);
	let error = $state<string | null>(null);
	let paper = $state<HTMLElement | undefined>();

	async function print() {
		error = null;
		try {
			await invoke('print_run');
		} catch (e) {
			error = errMessage(e);
		}
	}

	/** Wait for every picture, so the dialog's preview has them. */
	async function picturesLoaded() {
		const imgs = [...(paper?.querySelectorAll('img') ?? [])];
		await Promise.all(imgs.map((img) => img.decode().catch(() => {})));
	}

	onMount(async () => {
		const id = page.url.searchParams.get('id') ?? '';
		try {
			doc = await invoke<PrintDoc | null>('print_document', { id });
		} catch (e) {
			error = errMessage(e);
		}
		if (!doc) {
			missing = error === null;
			return;
		}
		await tick();
		await picturesLoaded();
		await print();
	});
</script>

<div class="print-window">
	<div class="toolbar">
		<span class="title">{doc?.title ?? 'Print'}</span>
		{#if error}
			<span class="error-text">{error}</span>
		{/if}
		<button class="btn btn-primary" onclick={() => void print()} disabled={!doc}>Print…</button>
		<button class="btn" onclick={() => void getCurrentWebviewWindow().close()}>Close</button>
	</div>
	{#if doc}
		<article class="paper" bind:this={paper}>
			<!-- eslint-disable-next-line svelte/no-at-html-tags -- sanitized here, and by the window that made it -->
			{@html sanitizeHtml(doc.html)}
		</article>
	{:else if missing}
		<p class="empty">This document is no longer here. Print it again from where it came from.</p>
	{/if}
</div>

<style>
	/* The app's root style pins the page to one screen; a printout runs on. */
	:global(html),
	:global(body) {
		height: auto;
		overflow: visible;
	}

	.print-window {
		min-height: 100vh;
		background: var(--bg-secondary);
	}

	.toolbar {
		position: sticky;
		top: 0;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		background: var(--bg-primary);
		border-bottom: 1px solid var(--border);
	}

	.title {
		flex: 1;
		font-weight: 600;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.empty {
		padding: 2rem;
		color: var(--text-secondary);
	}

	/* Paper is white whatever the app's theme. */
	.paper {
		max-width: 760px;
		margin: 16px auto;
		padding: 32px 40px;
		background: #fff;
		color: #1f1c17;
		font-family: system-ui, sans-serif;
		line-height: 1.5;
		box-shadow: 0 1px 4px rgb(0 0 0 / 0.15);
	}

	.paper :global(a) {
		color: #1f4f8a;
	}

	.paper :global(img) {
		max-width: 100%;
		break-inside: avoid;
	}

	.paper :global(table) {
		border-collapse: collapse;
		margin: 1rem 0;
	}

	.paper :global(th),
	.paper :global(td) {
		border: 1px solid #bbb;
		padding: 4px 10px;
		text-align: left;
	}

	.paper :global(th) {
		background: #f4f1ea;
	}

	.paper :global(pre) {
		background: #f6f6f6;
		color: #1f1c17;
		padding: 0.75rem;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.paper :global(.code-header) {
		font-size: 0.75rem;
		color: #666;
	}

	.paper :global(.turn) {
		margin-top: 1.5rem;
	}

	.paper :global(.turn h2) {
		font-size: 0.8rem;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: #666;
		margin: 0 0 0.25rem;
	}

	.paper :global(.turn[data-role='user']) {
		border-left: 3px solid #ccc;
		padding-left: 12px;
	}

	@media print {
		.toolbar {
			display: none;
		}

		.print-window {
			background: #fff;
		}

		.paper {
			max-width: none;
			margin: 0;
			padding: 0;
			box-shadow: none;
		}
	}
</style>
