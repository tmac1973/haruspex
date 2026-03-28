<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import SearchStepComponent from '$lib/components/SearchStep.svelte';
	import SourceChip from '$lib/components/SourceChip.svelte';
	import { renderMarkdown } from '$lib/markdown';
	import {
		getConversations,
		getActiveConversation,
		getActiveConversationId,
		getIsGenerating,
		getStreamingContent,
		getErrorMessage,
		getSearchSteps,
		getSourceUrls,
		createConversation,
		setActiveConversation,
		deleteConversation,
		renameConversation,
		clearAllConversations,
		sendMessage,
		cancelGeneration
	} from '$lib/stores/chat.svelte';
	import { getServerState } from '$lib/stores/server.svelte';
	import { onMount, tick } from 'svelte';

	let inputText = $state('');
	let messagesContainer: HTMLDivElement | undefined = $state();
	let autoScroll = $state(true);
	let showScrollButton = $state(false);
	let sidebarCollapsed = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');

	function startRename(id: string, currentTitle: string) {
		renamingId = id;
		renameText = currentTitle;
	}

	function finishRename() {
		if (renamingId && renameText.trim()) {
			renameConversation(renamingId, renameText.trim());
		}
		renamingId = null;
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			finishRename();
		} else if (e.key === 'Escape') {
			renamingId = null;
		}
	}

	const conversations = $derived(getConversations());
	const activeConversation = $derived(getActiveConversation());
	const activeId = $derived(getActiveConversationId());
	const isGenerating = $derived(getIsGenerating());
	const streamingContent = $derived(getStreamingContent());
	const errorMessage = $derived(getErrorMessage());
	const searchSteps = $derived(getSearchSteps());
	const sourceUrls = $derived(getSourceUrls());
	const serverState = $derived(getServerState());

	const serverReady = $derived(serverState.status === 'ready');

	$effect(() => {
		// Auto-scroll when streaming content changes
		if (streamingContent && autoScroll) {
			scrollToBottom();
		}
	});

	$effect(() => {
		// Auto-scroll when new messages appear
		if (activeConversation?.messages.length) {
			if (autoScroll) {
				tick().then(scrollToBottom);
			}
		}
	});

	function scrollToBottom() {
		if (messagesContainer) {
			messagesContainer.scrollTop = messagesContainer.scrollHeight;
		}
	}

	function handleScroll() {
		if (!messagesContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
		const atBottom = scrollHeight - scrollTop - clientHeight < 50;
		autoScroll = atBottom;
		showScrollButton = !atBottom && isGenerating;
	}

	function handleScrollToBottom() {
		autoScroll = true;
		scrollToBottom();
	}

	async function handleSend() {
		const text = inputText.trim();
		if (!text || isGenerating) return;
		inputText = '';
		autoScroll = true;
		await sendMessage(text);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
		if (e.key === 'Escape' && isGenerating) {
			cancelGeneration();
		}
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
			e.preventDefault();
			createConversation();
		}
	}

	onMount(() => {
		window.addEventListener('keydown', handleGlobalKeydown);
		return () => window.removeEventListener('keydown', handleGlobalKeydown);
	});

	const renderedStreamingContent = $derived(
		streamingContent ? renderMarkdown(streamingContent) : ''
	);
</script>

<div class="chat-layout">
	<aside class="sidebar" class:collapsed={sidebarCollapsed}>
		<div class="sidebar-header">
			{#if !sidebarCollapsed}
				<button class="new-chat-btn" onclick={() => createConversation()}>+ New Chat</button>
			{/if}
			<button
				class="collapse-btn"
				onclick={() => (sidebarCollapsed = !sidebarCollapsed)}
				title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
			>
				{sidebarCollapsed ? '\u25B6' : '\u25C0'}
			</button>
		</div>
		{#if !sidebarCollapsed}
			<div class="conversation-list">
				{#each conversations as conv (conv.id)}
					<!-- svelte-ignore a11y_click_events_have_key_events -->
					<!-- svelte-ignore a11y_no_static_element_interactions -->
					<div
						class="conversation-item"
						class:active={conv.id === activeId}
						onclick={() => setActiveConversation(conv.id)}
						ondblclick={(e) => {
							e.stopPropagation();
							startRename(conv.id, conv.title);
						}}
					>
						{#if renamingId === conv.id}
							<input
								class="rename-input"
								type="text"
								bind:value={renameText}
								onblur={finishRename}
								onkeydown={handleRenameKeydown}
								onclick={(e) => e.stopPropagation()}
							/>
						{:else}
							<span class="conv-title">{conv.title}</span>
						{/if}
						<button
							class="delete-btn"
							onclick={(e) => {
								e.stopPropagation();
								deleteConversation(conv.id);
							}}
							title="Delete conversation"
						>
							&times;
						</button>
					</div>
				{/each}
			</div>
			{#if conversations.length > 0}
				<div class="sidebar-footer">
					<button
						class="clear-all-btn"
						onclick={() => {
							if (confirm('Delete all conversations?')) clearAllConversations();
						}}
					>
						Clear all
					</button>
				</div>
			{/if}
		{/if}
	</aside>

	<div class="chat-main">
		<div class="messages" bind:this={messagesContainer} onscroll={handleScroll}>
			{#if activeConversation && activeConversation.messages.length > 0}
				{#each activeConversation.messages as msg, i (i)}
					{#if msg.role !== 'system'}
						<ChatMessage message={msg} />
					{/if}
				{/each}

				{#if searchSteps.length > 0}
					<SearchStepComponent steps={searchSteps} />
				{/if}

				{#if isGenerating && streamingContent}
					<div class="message" data-role="assistant">
						<div class="message-label">Haruspex</div>
						<div class="message-content">
							{@html renderedStreamingContent}
							<span class="cursor"></span>
						</div>
					</div>
				{:else if isGenerating}
					<ThinkingIndicator />
				{/if}

				{#if sourceUrls.length > 0 && !isGenerating}
					<SourceChip urls={sourceUrls} />
				{/if}

				{#if errorMessage}
					<div class="error-message">
						<p>{errorMessage}</p>
					</div>
				{/if}
			{:else}
				<div class="empty-state">
					<h2>Start a conversation</h2>
					<p>Type a message below to begin chatting with Haruspex.</p>
					{#if !serverReady}
						<p class="hint">Waiting for the AI model to load...</p>
					{/if}
				</div>
			{/if}

			{#if showScrollButton}
				<button class="scroll-btn" onclick={handleScrollToBottom}> &darr; New messages </button>
			{/if}
		</div>

		<div class="input-area">
			{#if isGenerating}
				<button class="stop-btn" onclick={() => cancelGeneration()}>Stop generating</button>
			{/if}
			<div class="input-row">
				<textarea
					bind:value={inputText}
					onkeydown={handleKeydown}
					placeholder={serverReady ? 'Type a message...' : 'Waiting for model to load...'}
					disabled={!serverReady && !activeConversation}
					rows="1"
				></textarea>
				<button class="send-btn" onclick={handleSend} disabled={!inputText.trim() || isGenerating}>
					Send
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.chat-layout {
		display: flex;
		height: calc(100vh - 45px);
		overflow: hidden;
	}

	/* Sidebar */
	.sidebar {
		width: 260px;
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		background: var(--bg-secondary);
		transition: width 0.2s ease;
	}

	.sidebar.collapsed {
		width: 40px;
	}

	.sidebar-header {
		display: flex;
		align-items: center;
		padding: 8px;
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}

	.new-chat-btn {
		flex: 1;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
	}

	.new-chat-btn:hover {
		background: var(--bg-secondary);
	}

	.collapse-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 4px 6px;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}

	.conversation-list {
		flex: 1;
		overflow-y: auto;
		padding: 4px;
	}

	.conversation-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 8px 10px;
		border: none;
		border-radius: 6px;
		background: none;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text-primary);
		gap: 4px;
	}

	.conversation-item:hover {
		background: var(--bg-primary);
	}

	.conversation-item.active {
		background: var(--bg-primary);
		font-weight: 500;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.1);
	}

	.conv-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.delete-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 1rem;
		padding: 0 4px;
		opacity: 0;
		transition: opacity 0.15s;
	}

	.conversation-item:hover .delete-btn {
		opacity: 1;
	}

	.delete-btn:hover {
		color: var(--error-text);
	}

	.rename-input {
		flex: 1;
		padding: 2px 6px;
		border: 1px solid var(--accent);
		border-radius: 4px;
		font-size: 0.85rem;
		background: var(--bg-primary);
		color: var(--text-primary);
		outline: none;
		min-width: 0;
	}

	.sidebar-footer {
		padding: 8px;
		border-top: 1px solid var(--border);
	}

	.clear-all-btn {
		width: 100%;
		padding: 6px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font-size: 0.8rem;
		cursor: pointer;
	}

	.clear-all-btn:hover {
		color: var(--error-text);
		background: var(--error-bg);
	}

	/* Chat main */
	.chat-main {
		flex: 1;
		display: flex;
		flex-direction: column;
		min-width: 0;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		position: relative;
	}

	/* Streaming message inline styles (matching ChatMessage component) */
	.messages .message {
		padding: 12px 16px;
		border-bottom: 1px solid var(--border);
	}

	.messages .message-label {
		font-size: 0.75rem;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		margin-bottom: 4px;
		color: var(--text-secondary);
	}

	.messages .message-content {
		line-height: 1.6;
		overflow-wrap: break-word;
	}

	.messages .message-content :global(p) {
		margin: 0 0 0.5em 0;
	}

	.messages .message-content :global(p:last-child) {
		margin-bottom: 0;
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

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-secondary);
		text-align: center;
		padding: 32px;
	}

	.empty-state h2 {
		margin: 0 0 8px 0;
		font-size: 1.2rem;
		color: var(--text-primary);
	}

	.empty-state p {
		margin: 0 0 4px 0;
	}

	.hint {
		font-size: 0.85rem;
		font-style: italic;
	}

	.error-message {
		padding: 12px 16px;
		background: var(--error-bg);
		color: var(--error-text);
		border-bottom: 1px solid var(--error-border);
		font-size: 0.9rem;
	}

	.error-message p {
		margin: 0;
	}

	.scroll-btn {
		position: sticky;
		bottom: 8px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 16px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 16px;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text-primary);
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
		z-index: 10;
	}

	/* Input area */
	.input-area {
		border-top: 1px solid var(--border);
		padding: 12px 16px;
		background: var(--bg-primary);
	}

	.stop-btn {
		display: block;
		margin: 0 auto 8px;
		padding: 4px 16px;
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.stop-btn:hover {
		background: var(--error-bg);
		color: var(--error-text);
		border-color: var(--error-border);
	}

	.input-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	textarea {
		flex: 1;
		padding: 10px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		resize: none;
		font-family: inherit;
		font-size: 0.95rem;
		line-height: 1.4;
		min-height: 40px;
		max-height: 200px;
		outline: none;
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	textarea:focus {
		border-color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
	}

	textarea:disabled {
		background: var(--bg-secondary);
		cursor: not-allowed;
	}

	.send-btn {
		padding: 10px 20px;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.9rem;
		font-weight: 500;
		white-space: nowrap;
	}

	.send-btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
