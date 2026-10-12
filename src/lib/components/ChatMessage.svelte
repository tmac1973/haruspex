<script lang="ts">
	import { renderMarkdown, splitThinkChannels, stripMarkdownForTTS } from '#lib/markdown.ts';
	import { resolvedImages, stripFor } from '#lib/images/figure.ts';
	import ChatImageStrip from '#lib/components/ChatImageStrip.svelte';
	import type { SearchStep } from '#lib/agent/loop.ts';
	import ThinkingPanel from '#lib/components/ThinkingPanel.svelte';
	import SpeakerButton from '#lib/components/SpeakerButton.svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import { createCopyAction } from '#lib/utils/clipboard.svelte.ts';
	import { formatDuration } from '#lib/utils/format.ts';
	import { messageText, type ChatMessage, type MessageContentPart } from '#lib/api.ts';
	import { typedText } from '#lib/skills/content.ts';
	import type { CodePathLinker } from '#lib/code/paths.ts';
	import BranchGlyph from '#lib/components/code/BranchGlyph.svelte';

	interface Props {
		message: ChatMessage;
		isStreaming?: boolean;
		tokensPerSecond?: number;
		/**
		 * Whole-turn wall clock, shown just before the rate. Not the same span
		 * the rate is measured over: `tokensPerSecond` covers the final model
		 * call, this covers everything the turn did — tool calls included.
		 */
		elapsedMs?: number;
		/**
		 * This message's archived tool steps. Only needed to decide whether the
		 * model searched for pictures it then failed to embed — see
		 * `images/figure`.`stripFor`.
		 */
		steps?: SearchStep[];
		/** File references to link, in the Code transcript only (see `renderMarkdown`). */
		codePaths?: CodePathLinker;
		/** "Fork from here" (the Code transcript). Shown on user and assistant messages. */
		onFork?: () => void;
		/** Why forking is not possible right now; the button is inert and says so. */
		forkBlocked?: string | null;
	}

	let {
		message,
		isStreaming = false,
		tokensPerSecond,
		elapsedMs,
		steps,
		codePaths,
		onFork,
		forkBlocked = null
	}: Props = $props();

	let elapsedLabel = $derived(
		typeof elapsedMs === 'number' && elapsedMs > 0 ? formatDuration(elapsedMs) : ''
	);

	let tokRateLabel = $derived(
		typeof tokensPerSecond === 'number' && tokensPerSecond > 0
			? `${tokensPerSecond < 10 ? tokensPerSecond.toFixed(1) : Math.round(tokensPerSecond)} tok/s`
			: ''
	);

	// Extract plain text from the message (handles both string and content array)
	let textContent = $derived(messageText(message.content));
	// A skill run with `/name` travels in the message; show what was typed.
	let userText = $derived(typedText(textContent));
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
	let renderedContent = $derived(
		answerText ? renderMarkdown(answerText, resolvedImages, codePaths) : ''
	);
	// Empty while streaming: the answer is not finished, so "the model embedded
	// nothing" is not yet a fact about it.
	let stripImages = $derived(
		!isStreaming && message.role === 'assistant' ? stripFor(answerText, steps ?? []) : []
	);
	let plainText = $derived(
		answerText ? stripMarkdownForTTS(answerText, getSettings().ttsReadTablesByColumn) : ''
	);

	const copy = createCopyAction();

	function fork() {
		if (!forkBlocked) onFork?.();
	}
</script>

{#snippet forkButton()}
	<button
		class="icon-btn fork"
		class:blocked={!!forkBlocked}
		aria-disabled={!!forkBlocked}
		title={forkBlocked ??
			(message.role === 'user'
				? 'Fork from here: a new session with everything before this message, and this message in its input box'
				: 'Fork from here: a new session with everything up to this answer')}
		aria-label="Fork from here"
		onclick={fork}
	>
		<BranchGlyph />
	</button>
{/snippet}

<div class="message" data-role={message.role}>
	<div class="message-label">
		{message.role === 'user' ? 'You' : 'Haruspex'}
	</div>
	<div class="message-content markdown">
		{#if message.role === 'user'}
			{#if imageUrls.length > 0}
				<div class="message-images">
					{#each imageUrls as url, i (i)}
						<img src={url} alt="Attached" class="message-image" />
					{/each}
				</div>
			{/if}
			{#if userText}
				<p>{userText}</p>
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
			<ChatImageStrip images={stripImages} />
			{#if isStreaming}
				<span class="streaming-caret"></span>
			{/if}
		{/if}
	</div>
	{#if message.role === 'assistant' && message.content && !isStreaming}
		<div class="message-footer">
			{#if elapsedLabel}
				<span class="elapsed" title="Total time for this turn, including any tools it ran"
					>{elapsedLabel}</span
				>
			{/if}
			{#if tokRateLabel}
				<span class="tok-rate" title="Generation speed for this response">{tokRateLabel}</span>
			{/if}
			<SpeakerButton text={plainText} />
			<button class="icon-btn" title="Copy to clipboard" onclick={() => copy.copy(textContent)}>
				{copy.state === 'copied' ? '\u2705' : '\u{1F4CB}'}
			</button>
			{#if onFork}
				{@render forkButton()}
			{/if}
		</div>
	{:else if message.role === 'user' && onFork}
		<div class="message-footer user-footer">
			{@render forkButton()}
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

	.fork {
		display: inline-flex;
		align-items: center;
	}

	.fork.blocked {
		opacity: 0.45;
		cursor: default;
	}

	/* A user message has nothing else down there; keep it out of the way. */
	.user-footer {
		padding-top: 0;
		opacity: 0;
		transition: opacity 0.1s;
	}

	.message:hover .user-footer,
	.user-footer:focus-within {
		opacity: 1;
	}

	.tok-rate,
	.elapsed {
		font-size: 0.75rem;
		color: var(--text-secondary);
		font-variant-numeric: tabular-nums;
	}
</style>
