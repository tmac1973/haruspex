<script lang="ts">
	import { renderMarkdown, splitThinkChannels, stripMarkdownForTTS } from '$lib/markdown';
	import { resolvedImages } from '$lib/images/figure';
	import ThinkingPanel from '$lib/components/ThinkingPanel.svelte';
	import SpeakerButton from '$lib/components/SpeakerButton.svelte';
	import { getSettings } from '$lib/stores/settings';
	import { createCopyAction } from '$lib/utils/clipboard.svelte';
	import { messageText, type ChatMessage, type MessageContentPart } from '$lib/api';

	interface Props {
		message: ChatMessage;
		isStreaming?: boolean;
		tokensPerSecond?: number;
	}

	let { message, isStreaming = false, tokensPerSecond }: Props = $props();

	let tokRateLabel = $derived(
		typeof tokensPerSecond === 'number' && tokensPerSecond > 0
			? `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`
			: ''
	);

	// Extract plain text from the message (handles both string and content array)
	let textContent = $derived(messageText(message.content));
	// Extract any image URLs from multimodal content for display
	let imageUrls = $derived(
		typeof message.content === 'string'
			? []
			: (message.content as MessageContentPart[])
					.filter(
						(p): p is { type: 'image_url'; image_url: { url: string } } => p.type === 'image_url'
					)
					.map((p) => p.image_url.url)
	);
	/**
	 * Reasoning is split out and rendered as a component rather than left in
	 * the markdown. Inside the HTML string it was a <details> destroyed and
	 * rebuilt collapsed on every streaming delta, and an in-progress block —
	 * which has no closing tag yet — rendered as nothing at all.
	 *
	 * `splitThinkChannels` already treats an unterminated trailing <think> as
	 * reasoning, which is exactly the live case, so no separate live-tail
	 * helper is needed.
	 */
	let channels = $derived(splitThinkChannels(textContent));
	/**
	 * A message that is ALL reasoning is its own answer: Qwen sometimes wraps
	 * a whole response in <think> and emits EOS. Promote it to prose rather
	 * than leaving an empty bubble with a disclosure hanging off it. While
	 * streaming, the same shape means "still thinking" and belongs in the
	 * panel instead.
	 */
	let thinkingOnly = $derived(
		!isStreaming && channels.answer.trim() === '' && channels.reasoning.trim() !== ''
	);
	let answerText = $derived(thinkingOnly ? channels.reasoning : channels.answer);
	// `resolvedImages` reads the live SvelteMap on every call, so this
	// re-derives as each image resolves and they appear one by one.
	let renderedContent = $derived(answerText ? renderMarkdown(answerText, resolvedImages) : '');
	let plainText = $derived(
		answerText ? stripMarkdownForTTS(answerText, getSettings().ttsReadTablesByColumn) : ''
	);

	const copy = createCopyAction();
</script>

<div class="message" data-role={message.role}>
	<div class="message-label">
		{message.role === 'user' ? 'You' : 'Haruspex'}
	</div>
	<div class="message-content">
		{#if message.role === 'user'}
			{#if imageUrls.length > 0}
				<div class="message-images">
					{#each imageUrls as url, i (i)}
						<img src={url} alt="Attached" class="message-image" />
					{/each}
				</div>
			{/if}
			{#if textContent}
				<p>{textContent}</p>
			{/if}
		{:else}
			{#if channels.reasoning.trim() && !thinkingOnly}
				<ThinkingPanel
					text={channels.reasoning}
					live={isStreaming && channels.answer.trim() === ''}
					defaultOpen={isStreaming && channels.answer.trim() === ''}
				/>
			{/if}
			{@html renderedContent}
			{#if isStreaming}
				<span class="streaming-caret"></span>
			{/if}
		{/if}
	</div>
	{#if message.role === 'assistant' && message.content && !isStreaming}
		<div class="message-footer">
			{#if tokRateLabel}
				<span class="tok-rate" title="Generation speed for this response">{tokRateLabel}</span>
			{/if}
			<SpeakerButton text={plainText} />
			<button class="icon-btn" title="Copy to clipboard" onclick={() => copy.copy(textContent)}>
				{copy.state === 'copied' ? '\u2705' : '\u{1F4CB}'}
			</button>
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

	.message-images {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 8px;
	}

	.message-image {
		max-width: 240px;
		max-height: 240px;
		border-radius: 8px;
		border: 1px solid var(--border);
		object-fit: cover;
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
		margin: 0.75em 16px 0.75em 0;
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

	/* Images the model put in its answer. Served from haruspex-img://, never
	   fetched by the webview — see images/figure.ts. */
	.message-content :global(figure.chat-image) {
		margin: 0.75rem 0;
	}

	.message-content :global(figure.chat-image img) {
		display: block;
		max-width: 100%;
		/* Height-capped so one tall image cannot push the rest of an answer
		   off screen; `auto` width keeps the aspect ratio. */
		max-height: 22rem;
		width: auto;
		height: auto;
		border-radius: 8px;
		border: 1px solid var(--border);
	}

	/* Credit line. CC BY and CC BY-SA require this wherever the image is
	   shown, so it is generated from stored provenance rather than left to
	   the model. */
	.message-content :global(figcaption.chat-image-credit) {
		margin-top: 0.3rem;
		font-size: 0.75rem;
		color: var(--text-muted);
		line-height: 1.3;
	}

	.message-content :global(figcaption.chat-image-credit a) {
		color: var(--text-muted);
		text-decoration: underline;
	}

	.message-content :global(figcaption.chat-image-credit a:hover) {
		color: var(--text-secondary);
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
		align-items: center;
		gap: 8px;
	}

	.icon-btn {
		background: none;
		border: none;
		cursor: pointer;
		font-size: 0.9rem;
		padding: 4px;
		border-radius: 4px;
		color: var(--text-secondary);
		line-height: 1;
	}

	.icon-btn:hover {
		background: var(--bg-secondary);
	}

	.tok-rate {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
