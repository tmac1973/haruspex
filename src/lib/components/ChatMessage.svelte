<script lang="ts">
	import { renderMarkdown, stripMarkdownForTTS } from '$lib/markdown';
	import SpeakerButton from '$lib/components/SpeakerButton.svelte';
	import type { ChatMessage } from '$lib/api';

	interface Props {
		message: ChatMessage;
		isStreaming?: boolean;
	}

	let { message, isStreaming = false }: Props = $props();

	let renderedContent = $derived(message.content ? renderMarkdown(message.content) : '');
	let plainText = $derived(message.content ? stripMarkdownForTTS(message.content) : '');
</script>

<div class="message" data-role={message.role}>
	<div class="message-label">
		{message.role === 'user' ? 'You' : 'Haruspex'}
	</div>
	<div class="message-content">
		{#if message.role === 'user'}
			<p>{message.content}</p>
		{:else}
			{@html renderedContent}
			{#if isStreaming}
				<span class="cursor"></span>
			{/if}
		{/if}
	</div>
	{#if message.role === 'assistant' && message.content && !isStreaming}
		<div class="message-footer">
			<SpeakerButton text={plainText} />
		</div>
	{/if}
</div>

<style>
	.message {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	.message-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 4px;
		color: var(--text-secondary);
	}

	[data-role='user'] .message-label {
		color: var(--accent);
	}

	.message-content {
		line-height: 1.6;
		overflow-wrap: break-word;
	}

	.message-content :global(p) {
		margin: 0 0 0.5em 0;
	}

	.message-content :global(p:last-child) {
		margin-bottom: 0;
	}

	.message-content :global(ul),
	.message-content :global(ol) {
		margin: 0.5em 0;
		padding-left: 1.5em;
	}

	.message-content :global(table) {
		width: 100%;
		border-collapse: collapse;
		margin: 0.75em 0;
		font-size: 0.9em;
	}

	.message-content :global(th),
	.message-content :global(td) {
		border: 1px solid var(--border);
		padding: 6px 12px;
		text-align: left;
	}

	.message-content :global(th) {
		background: var(--bg-secondary);
		font-weight: 600;
	}

	.message-content :global(tr:nth-child(even)) {
		background: color-mix(in srgb, var(--bg-secondary) 50%, transparent);
	}

	.message-content :global(.code-block) {
		margin: 0.75em 0;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--border);
	}

	.message-content :global(.code-header) {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 4px 12px;
		background: var(--bg-secondary);
		font-size: 0.75rem;
	}

	.message-content :global(.code-lang) {
		color: var(--text-secondary);
	}

	.message-content :global(.copy-btn) {
		background: none;
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 2px 8px;
		font-size: 0.7rem;
		cursor: pointer;
		color: var(--text-secondary);
	}

	.message-content :global(.copy-btn:hover) {
		background: var(--bg-primary);
	}

	.message-content :global(pre) {
		margin: 0;
		padding: 12px;
		overflow-x: auto;
		background: var(--code-bg);
		color: #d4d4d4;
		font-size: 0.85rem;
		line-height: 1.5;
	}

	.message-content :global(code) {
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
	}

	.message-content :global(:not(pre) > code) {
		background: var(--bg-secondary);
		padding: 0.15em 0.4em;
		border-radius: 3px;
		font-size: 0.9em;
	}

	.message-content :global(.thinking-block) {
		margin: 0.5em 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 0;
		font-size: 0.85em;
		color: var(--text-secondary);
	}

	.message-content :global(.thinking-block summary) {
		padding: 6px 12px;
		cursor: pointer;
		font-style: italic;
		user-select: none;
	}

	.message-content :global(.thinking-block summary:hover) {
		color: var(--text-primary);
	}

	.message-content :global(.thinking-block > :not(summary)) {
		padding: 0 12px;
	}

	.message-footer {
		padding: 2px 16px 8px;
		display: flex;
		gap: 8px;
	}

	.cursor {
		display: inline-block;
		width: 2px;
		height: 1em;
		background: var(--text-primary);
		animation: blink 0.8s step-end infinite;
		vertical-align: text-bottom;
		margin-left: 1px;
	}

	@keyframes blink {
		50% {
			opacity: 0;
		}
	}
</style>
