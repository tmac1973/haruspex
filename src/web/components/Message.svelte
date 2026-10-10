<script lang="ts">
	/**
	 * One message, as the desktop draws it: reasoning folded away in a
	 * ThinkingPanel, the answer as markdown. Images aren't served to the web
	 * client yet, so an attached one is named, not shown.
	 */
	import { messageText, type ChatMessage } from '#lib/api.ts';
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
	const images = $derived(
		Array.isArray(message.content)
			? message.content.filter((p) => p.type === 'image_url').length
			: 0
	);
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
	{#if images > 0}
		<p class="note">
			{images === 1 ? 'An image' : `${images} images`} on your computer, not shown here.
		</p>
	{/if}
</div>

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

	.note {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
</style>
