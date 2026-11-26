<script lang="ts">
	/**
	 * A notebook's own agent chat, beside the notebook. Kept with the
	 * notebook; the agent sees the notebook's cards every turn. Documents
	 * dropped here are read into the message and kept for the agent to attach.
	 */
	import { renderMarkdown } from '#lib/markdown.ts';
	import ThinkingIndicator from '#lib/components/ThinkingIndicator.svelte';
	import { startDragResize } from '#lib/utils/dragResize.ts';
	import { persistItem } from '#lib/persist.ts';
	import { fileDropTarget } from '#lib/utils/fileDrop.ts';
	import { attachDocument, readerFor, splitPath } from '#lib/notebooks/droppedFiles.ts';
	import {
		clearNotebookChat,
		getNotebookChat,
		loadNotebookChat,
		sendNotebookChat,
		stopNotebookChat
	} from '#lib/notebooks/notebookChat.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import type { PeerNotebookChat } from '#lib/notebooks/backend.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	interface Props {
		notebookId: string;
		title: string;
		onclose: () => void;
		/** Another computer's notebook: its chat runs there. */
		peer?: PeerNotebookChat | null;
	}

	let { notebookId, title, onclose, peer = null }: Props = $props();

	const chat = $derived(peer ? peer.view : getNotebookChat(notebookId));
	let draft = $state('');
	/** Documents to send with the next message. */
	let docs = $state<{ name: string; block: string }[]>([]);
	let reading = $state(0);
	let fileOver = $state(false);
	let log = $state<HTMLDivElement | null>(null);

	// The panel's width: dragged at its left edge, kept for next time.
	const WIDTH_KEY = 'haruspex.notebookChatWidth';
	const MIN_WIDTH = 300;
	// The notebook beside it keeps 560px with the list; in a narrow window
	// (the 800px a first start opens at) the panel gives way down to this.
	const NARROW_WIDTH = 240;
	const maxWidth = () => Math.max(MIN_WIDTH, window.innerWidth - 560);
	function savedWidth(): number {
		try {
			const w = Number(localStorage.getItem(WIDTH_KEY));
			return Number.isFinite(w) && w > 0 ? Math.min(Math.max(w, MIN_WIDTH), maxWidth()) : 380;
		} catch {
			return 380;
		}
	}
	let width = $state(savedWidth());
	let windowWidth = $state(window.innerWidth);
	const shownWidth = $derived(Math.min(width, Math.max(NARROW_WIDTH, windowWidth - 560)));

	function startResize(event: MouseEvent) {
		// On the right: dragging its edge left widens it.
		startDragResize(event, {
			width: shownWidth,
			widens: 'left',
			clamp: (w) => Math.max(MIN_WIDTH, Math.min(maxWidth(), w)),
			onResize: (w) => (width = w),
			onDone: (w) => {
				try {
					persistItem(WIDTH_KEY, String(Math.round(w)));
				} catch {
					// a convenience only
				}
			}
		});
	}

	$effect(() => {
		if (!peer) void loadNotebookChat(notebookId);
	});

	// Keep the newest message in view.
	$effect(() => {
		void chat.messages.length;
		void chat.streaming;
		if (log) log.scrollTop = log.scrollHeight;
	});

	async function onFiles(paths: string[]) {
		if (peer) {
			showToast('Drop documents on the computer this notebook is on.', { kind: 'info' });
			return;
		}
		for (const path of paths) {
			const { name } = splitPath(path);
			if (!readerFor(name)) {
				showToast(`${name}: drop pictures and other files on the notebook to keep them.`, {
					kind: 'info'
				});
				continue;
			}
			reading++;
			try {
				const { block } = await attachDocument(path);
				docs = [...docs, { name, block }];
			} catch (e) {
				showToast(`${name}: ${errMessage(e)}`, { kind: 'error' });
			} finally {
				reading--;
			}
		}
	}

	function send() {
		const text = draft.trim();
		if ((!text && docs.length === 0) || chat.busy) return;
		const message = [text, ...docs.map((d) => d.block)].filter(Boolean).join('\n\n');
		draft = '';
		docs = [];
		if (peer) void peer.send(message);
		else void sendNotebookChat(notebookId, message);
	}

	/** A user message without its document text, as the panel shows it. */
	function shown(content: string): string {
		return content.replace(
			/Attached document: (.+?) \(file: [0-9a-f]{64}\)\n```[\s\S]*?\n```/g,
			'📎 $1'
		);
	}
</script>

<svelte:window bind:innerWidth={windowWidth} />

<aside
	style="width: {shownWidth}px"
	class="panel"
	class:file-over={fileOver}
	aria-label="Notebook chat"
	use:fileDropTarget={{ onFiles: (p) => void onFiles(p), onDragChange: (o) => (fileOver = o) }}
>
	<button
		class="resize-handle"
		onmousedown={startResize}
		aria-label="Drag to resize the chat"
		title="Drag to resize"
	></button>
	<header>
		<h3 title="Ask about {title}">Ask about this notebook</h3>
		<div class="tools">
			{#if chat.messages.length > 0 && !chat.busy && !peer}
				<button
					class="mini"
					onclick={() => void clearNotebookChat(notebookId)}
					title="Start this chat over; the notebook stays as it is"
				>
					Clear
				</button>
			{/if}
			<button class="mini" onclick={onclose} aria-label="Hide the chat" title="Hide the chat">
				»
			</button>
		</div>
	</header>
	<div class="log" bind:this={log}>
		{#if chat.messages.length === 0 && !chat.busy}
			<p class="hint">
				Ask the agent to organize, research or add to this notebook. Drop a PDF, Word or spreadsheet
				file here to work from it.
			</p>
		{/if}
		{#each chat.messages as m, i (i)}
			<div class="msg {m.role}">
				{#if m.role === 'user'}
					<p>{shown(m.content)}</p>
				{:else}
					<div class="markdown">{@html renderMarkdown(m.content)}</div>
				{/if}
			</div>
		{/each}
		{#if chat.busy}
			<div class="msg assistant">
				{#if chat.streaming}
					<div class="markdown">{@html renderMarkdown(chat.streaming)}</div>
				{/if}
				<ThinkingIndicator bare caption={chat.step ?? 'Working…'} />
			</div>
		{/if}
		{#if chat.error}
			<p class="error">{chat.error}</p>
		{/if}
	</div>
	{#if docs.length > 0 || reading > 0}
		<div class="docs">
			{#each docs as d, i (i)}
				<span class="doc">
					📎 {d.name}
					<button
						aria-label="Remove {d.name}"
						onclick={() => (docs = docs.filter((_, j) => j !== i))}
					>
						×
					</button>
				</span>
			{/each}
			{#if reading > 0}<span class="doc">Reading…</span>{/if}
		</div>
	{/if}
	<div class="composer">
		<textarea
			bind:value={draft}
			placeholder="Organize these notes…"
			aria-label="Message"
			rows="3"
			onkeydown={(e) => {
				if (e.key === 'Enter' && !e.shiftKey) {
					e.preventDefault();
					send();
				}
			}}></textarea>
		{#if chat.busy}
			<button
				class="send stop"
				onclick={() => (peer ? void peer.stop() : stopNotebookChat(notebookId))}
			>
				Stop
			</button>
		{:else}
			<button class="send" onclick={send} disabled={reading > 0}>Send</button>
		{/if}
	</div>
</aside>

<style>
	.panel {
		position: relative;
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		border-left: 1px solid var(--border);
		background: var(--bg-secondary);
		min-height: 0;
	}

	.panel.file-over {
		outline: 2px dashed var(--accent);
		outline-offset: -6px;
	}

	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 10px 12px 6px;
	}

	h3 {
		margin: 0;
		font-size: 0.95rem;
	}

	.tools {
		display: flex;
		gap: 4px;
	}

	.mini {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 2px 6px;
		border-radius: 4px;
		font-size: 0.82rem;
	}

	.mini:hover {
		color: var(--text-primary);
		background: var(--bg-primary);
	}

	.log {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 4px 12px;
	}

	.hint {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.msg {
		margin: 8px 0;
		font-size: 0.88rem;
		line-height: 1.45;
	}

	.msg.user p {
		margin: 0;
		padding: 6px 10px;
		border-radius: 8px;
		background: var(--user-bubble);
		white-space: pre-wrap;
		word-break: break-word;
	}

	.error {
		color: var(--error-text);
		font-size: 0.85rem;
	}

	.docs {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		padding: 4px 12px;
	}

	.doc {
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1px 8px;
		font-size: 0.75rem;
		background: var(--bg-primary);
	}

	.doc button {
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 0 2px;
	}

	.composer {
		display: flex;
		gap: 6px;
		padding: 8px 12px 12px;
	}

	textarea {
		flex: 1;
		resize: none;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
		font-size: 0.88rem;
		padding: 6px 8px;
	}

	.send {
		align-self: flex-end;
		border: none;
		border-radius: 8px;
		background: var(--accent);
		color: var(--accent-contrast);
		cursor: pointer;
		padding: 6px 12px;
	}

	.send:disabled {
		opacity: 0.5;
	}

	.send.stop {
		background: var(--bg-raised);
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.resize-handle {
		position: absolute;
		left: -3px;
		top: 0;
		bottom: 0;
		z-index: 5;
		width: 6px;
		padding: 0;
		border: 0;
		background: transparent;
		cursor: col-resize;
	}

	.resize-handle:hover,
	.resize-handle:active {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}
</style>
