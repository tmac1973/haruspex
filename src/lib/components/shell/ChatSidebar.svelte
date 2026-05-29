<script lang="ts">
	import { onMount } from 'svelte';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import MicButton from '$lib/components/MicButton.svelte';
	import SearchStepComponent from '$lib/components/SearchStep.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import {
		bindShellComposer,
		cancelShellTurn,
		getShellLastError,
		getShellMessages,
		getShellMessageSteps,
		getShellSearchSteps,
		getShellSidebarOpen,
		getShellStreamingContent,
		getShellTicket,
		isShellSubmitting,
		newShellChat,
		setShellComposerFocused,
		submitChatMessage,
		toggleShellSidebar,
		unbindShellComposer
	} from '$lib/stores/shell.svelte';

	const open = $derived(getShellSidebarOpen());
	const messages = $derived(getShellMessages());
	const streaming = $derived(getShellStreamingContent());
	const submitting = $derived(isShellSubmitting());
	const ticket = $derived(getShellTicket());
	const lastError = $derived(getShellLastError());
	const searchSteps = $derived(getShellSearchSteps());
	const messageSteps = $derived(getShellMessageSteps());

	let composerText = $state('');
	let composerEl = $state<HTMLTextAreaElement | null>(null);
	let threadEl = $state<HTMLDivElement | null>(null);

	const streamingMessage = $derived(
		streaming
			? {
					role: 'assistant' as const,
					content: streaming
				}
			: null
	);

	function autosize() {
		if (!composerEl) return;
		composerEl.style.height = 'auto';
		composerEl.style.height = Math.min(composerEl.scrollHeight, 160) + 'px';
	}

	function onComposerInput() {
		autosize();
	}

	async function handleSend() {
		const text = composerText.trim();
		if (!text || submitting) return;
		composerText = '';
		autosize();
		await submitChatMessage(text);
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
		if (event.key === 'Escape' && submitting) {
			event.preventDefault();
			cancelShellTurn();
		}
	}

	$effect(() => {
		// Track every change that grows the thread (new message OR streaming
		// delta) and pin the scroll position at the bottom. Reading the
		// deps inside the effect tells Svelte's runes to re-fire.
		void messages.length;
		void streaming;
		if (!threadEl) return;
		queueMicrotask(() => {
			if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
		});
	});

	onMount(() => {
		bindShellComposer(() => composerEl?.focus());
		return () => unbindShellComposer();
	});
</script>

{#if open}
	<aside class="sidebar" aria-label="LLM troubleshooting assistant">
		<header>
			<h3>Assistant</h3>
			<div class="actions">
				<button onclick={newShellChat} disabled={submitting} title="Clear chat">New chat</button>
				<button onclick={toggleShellSidebar} title="Collapse">›</button>
			</div>
		</header>
		<div class="thread" bind:this={threadEl}>
			{#if messages.length === 0 && !streamingMessage}
				<div class="placeholder">
					Type a question or hold <kbd>F2</kbd> to speak. Your last few shell commands and their output
					are attached automatically — number configurable in Settings → Shell.
				</div>
			{/if}
			{#each messages as msg, i (i)}
				{#if msg.role === 'assistant' && messageSteps[i]?.length}
					<SearchStepComponent steps={messageSteps[i]} />
				{/if}
				<ChatMessage message={msg} />
			{/each}
			{#if searchSteps.length > 0}
				<SearchStepComponent steps={searchSteps} />
			{/if}
			{#if streamingMessage}
				<ChatMessage message={streamingMessage} isStreaming />
			{:else if submitting && (!ticket || ticket.state === 'running')}
				<ThinkingIndicator />
			{/if}
			{#if ticket && ticket.state === 'waiting'}
				<div class="queue-hint">
					Waiting behind {ticket.consumer === 'chat'
						? 'a chat turn'
						: typeof ticket.consumer === 'object'
							? `job "${ticket.consumer.jobName}"`
							: 'another shell turn'}…
				</div>
			{/if}
			{#if lastError}
				<div class="error">{lastError}</div>
			{/if}
		</div>
		<footer class="composer">
			<textarea
				bind:this={composerEl}
				bind:value={composerText}
				oninput={onComposerInput}
				onkeydown={onComposerKeydown}
				onfocus={() => setShellComposerFocused(true)}
				onblur={() => setShellComposerFocused(false)}
				placeholder="Ask the assistant… (Enter to send, Shift+Enter for newline, Ctrl+` switch to shell)"
				rows="1"
				disabled={submitting}
			></textarea>
			<MicButton onTranscription={(text) => submitChatMessage(text)} disabled={submitting} />
			{#if submitting}
				<button class="cancel" onclick={cancelShellTurn} title="Cancel (Esc)">Stop</button>
			{:else}
				<button
					class="send"
					onclick={handleSend}
					disabled={!composerText.trim()}
					title="Send (Enter)">Send</button
				>
			{/if}
		</footer>
	</aside>
{:else}
	<button
		class="rail"
		onclick={toggleShellSidebar}
		title="Open assistant"
		aria-label="Open assistant sidebar"
	>
		<span class="rail-glyph">‹</span>
		<span class="rail-label">Assistant</span>
	</button>
{/if}

<style>
	.sidebar {
		display: flex;
		flex-direction: column;
		width: 33%;
		min-width: 320px;
		max-width: 560px;
		border-left: 1px solid var(--border);
		background: var(--bg-primary);
		flex-shrink: 0;
		min-height: 0;
	}

	.sidebar header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 6px 10px;
		border-bottom: 1px solid var(--border);
	}

	.sidebar h3 {
		margin: 0;
		font-size: 0.85rem;
		font-weight: 600;
	}

	.actions {
		display: flex;
		gap: 4px;
	}

	.actions button {
		appearance: none;
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		padding: 3px 8px;
		font-size: 0.75rem;
		border-radius: 4px;
		cursor: pointer;
	}

	.actions button:hover:not(:disabled) {
		background: var(--bg-tertiary, var(--bg-secondary));
	}

	.actions button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.thread {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 8px 10px 14px;
	}

	.placeholder {
		color: var(--text-secondary);
		font-size: 0.85rem;
		padding: 16px 8px;
		text-align: center;
		line-height: 1.5;
	}

	.queue-hint {
		font-size: 0.78rem;
		color: var(--text-secondary);
		font-style: italic;
		padding: 8px 4px;
	}

	.error {
		font-size: 0.8rem;
		color: var(--error, #c66);
		padding: 8px;
		border: 1px solid var(--error, #c66);
		border-radius: 4px;
		margin-top: 8px;
	}

	.composer {
		display: flex;
		gap: 6px;
		align-items: flex-end;
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}

	.composer textarea {
		flex: 1;
		min-height: 34px;
		max-height: 160px;
		resize: none;
		padding: 6px 8px;
		font-family: inherit;
		font-size: 0.85rem;
		line-height: 1.4;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		outline: none;
	}

	.composer textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
	}

	.composer textarea:disabled {
		background: var(--bg-secondary);
		cursor: not-allowed;
	}

	.composer .send,
	.composer .cancel {
		appearance: none;
		padding: 6px 14px;
		font-size: 0.8rem;
		font-weight: 500;
		border-radius: 6px;
		cursor: pointer;
	}

	.composer .send {
		background: var(--accent);
		color: white;
		border: 1px solid var(--accent);
	}

	.composer .send:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.composer .cancel {
		background: none;
		color: var(--text-primary);
		border: 1px solid var(--border);
	}

	.rail {
		appearance: none;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 8px;
		padding: 12px 4px;
		width: 28px;
		border-left: 1px solid var(--border);
		border-top: 0;
		border-right: 0;
		border-bottom: 0;
		background: var(--bg-primary);
		color: var(--text-secondary);
		cursor: pointer;
		flex-shrink: 0;
	}

	.rail:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
	}

	.rail-glyph {
		font-size: 1.2rem;
		line-height: 1;
	}

	.rail-label {
		writing-mode: vertical-rl;
		transform: rotate(180deg);
		font-size: 0.75rem;
		letter-spacing: 0.05em;
		text-transform: uppercase;
	}
</style>
