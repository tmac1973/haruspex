<script lang="ts">
	/**
	 * One message, as the desktop draws it: reasoning folded away in a
	 * ThinkingPanel, the answer as markdown. Attached images are data URLs in
	 * the thread, so they show here as they are; one stored any other way
	 * (the desktop's image cache) is named instead.
	 */
	import { messageText, type ChatMessage } from '#lib/api.ts';
	import Modal from '#lib/components/Modal.svelte';
	import ThinkingPanel from '#lib/components/ThinkingPanel.svelte';
	import { makeCodePathLinker } from '#lib/code/paths.ts';
	import { renderMarkdown, splitThinkChannels } from '#lib/markdown.ts';

	/** `root`: the session folder; paths in an answer that are inside it become file links. */
	let {
		message,
		streaming = false,
		root = null
	}: { message: ChatMessage; streaming?: boolean; root?: string | null } = $props();

	const codePaths = $derived(root ? makeCodePathLinker(root) : undefined);

	const text = $derived(messageText(message.content));
	const parts = $derived(splitThinkChannels(text));
	const urls = $derived(
		Array.isArray(message.content)
			? message.content.flatMap((p) => (p.type === 'image_url' ? [p.image_url.url] : []))
			: []
	);
	const shown = $derived(urls.filter((u) => u.startsWith('data:image/')));
	const elsewhere = $derived(urls.length - shown.length);
	let enlarged = $state<string | null>(null);
</script>

<div class="message" data-role={message.role}>
	{#if message.role === 'user'}
		<div class="user">{text}</div>
	{:else}
		{#if parts.reasoning.trim()}
			<ThinkingPanel text={parts.reasoning} live={streaming && !parts.answer} />
		{/if}
		{#if parts.answer.trim()}
			<!-- renderMarkdown sanitises its output. -->
			<!-- eslint-disable-next-line svelte/no-at-html-tags -->
			<div class="markdown">{@html renderMarkdown(parts.answer, undefined, codePaths)}</div>
		{/if}
	{/if}
	{#if shown.length > 0}
		<div class="images">
			{#each shown as url, i (i)}
				<button class="thumb" title="Show full size" onclick={() => (enlarged = url)}>
					<img src={url} alt="Attached" />
				</button>
			{/each}
		</div>
	{/if}
	{#if elsewhere > 0}
		<p class="note">
			{elsewhere === 1 ? 'An image' : `${elsewhere} images`} on your computer, not shown here.
		</p>
	{/if}
</div>

{#if enlarged}
	<Modal open title="Image" maxWidth={1100} dismissable onclose={() => (enlarged = null)}>
		<img class="full" src={enlarged} alt="Attached" />
	</Modal>
{/if}

<style>
	.message {
		padding: 10px 0;
	}

	.user {
		padding: 10px 12px;
		border-radius: 10px;
		background: var(--user-bubble, var(--bg-secondary));
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.markdown {
		line-height: 1.55;
		overflow-wrap: anywhere;
	}

	.markdown :global(pre) {
		overflow-x: auto;
	}

	.markdown :global(p:first-child) {
		margin-top: 0;
	}

	.markdown :global(p:last-child) {
		margin-bottom: 0;
	}

	.images {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-top: 8px;
	}

	.thumb {
		padding: 0;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: none;
		cursor: zoom-in;
		overflow: hidden;
	}

	.thumb img {
		display: block;
		max-width: 220px;
		max-height: 160px;
		object-fit: cover;
	}

	.full {
		display: block;
		max-width: 100%;
		max-height: 75vh;
		margin: 0 auto;
	}

	.note {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
