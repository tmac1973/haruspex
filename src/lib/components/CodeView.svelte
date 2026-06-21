<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import SearchStepComponent from '$lib/components/SearchStep.svelte';
	import { open } from '@tauri-apps/plugin-dialog';
	import { tick } from 'svelte';
	import { renderStreamingHtml } from '$lib/stores/chat.svelte';
	import {
		getCodeWorkingDir,
		setCodeWorkingDir,
		getCodeMessages,
		getCodeMessageSteps,
		getCodeStreamingContent,
		getCodeIsGenerating,
		getCodeIsWaitingForSlot,
		getCodeSearchSteps,
		getCodeError,
		getCodeContextNotice,
		clearCodeConversation,
		cancelCodeGeneration,
		submitCodeMessage
	} from '$lib/stores/code.svelte';

	let inputText = $state('');
	let messagesContainer: HTMLDivElement | undefined = $state();
	let autoScroll = $state(true);

	const workingDir = $derived(getCodeWorkingDir());
	const messages = $derived(getCodeMessages());
	const messageSteps = $derived(getCodeMessageSteps());
	const streamingContent = $derived(getCodeStreamingContent());
	const isGenerating = $derived(getCodeIsGenerating());
	const isWaitingForSlot = $derived(getCodeIsWaitingForSlot());
	const searchSteps = $derived(getCodeSearchSteps());
	const errorMessage = $derived(getCodeError());
	const contextNotice = $derived(getCodeContextNotice());
	const renderedStreaming = $derived(renderStreamingHtml(streamingContent));
	const dirLabel = $derived(workingDir ? workingDir.split('/').filter(Boolean).pop() : null);

	$effect(() => {
		if (streamingContent && autoScroll) scrollToBottom();
	});
	$effect(() => {
		if (messages.length && autoScroll) tick().then(scrollToBottom);
	});

	function scrollToBottom() {
		if (messagesContainer) messagesContainer.scrollTop = messagesContainer.scrollHeight;
	}
	function handleScroll() {
		if (!messagesContainer) return;
		const { scrollTop, scrollHeight, clientHeight } = messagesContainer;
		autoScroll = scrollHeight - scrollTop - clientHeight < 50;
	}

	async function pickDirectory() {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Select project directory'
			});
			if (typeof selected === 'string') setCodeWorkingDir(selected);
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	async function handleSend() {
		const text = inputText.trim();
		if (!text || isGenerating || !workingDir) return;
		inputText = '';
		autoScroll = true;
		await submitCodeMessage(text);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter' && !e.shiftKey) {
			e.preventDefault();
			handleSend();
		}
		if (e.key === 'Escape' && isGenerating) cancelCodeGeneration();
	}
</script>

<div class="code-layout">
	<div class="messages" bind:this={messagesContainer} onscroll={handleScroll}>
		{#if messages.length > 0}
			{#each messages as msg, i (i)}
				{#if msg.role !== 'system'}
					{#if msg.role === 'assistant' && messageSteps[i]?.length}
						<SearchStepComponent steps={messageSteps[i]} />
					{/if}
					<ChatMessage message={msg} />
				{/if}
			{/each}

			{#if searchSteps.length > 0}
				<SearchStepComponent steps={searchSteps} />
			{/if}

			{#if isWaitingForSlot}
				<div class="notice">Waiting for another inference request to finish…</div>
			{:else if isGenerating && streamingContent}
				<div class="message" data-role="assistant">
					<div class="message-label">Haruspex</div>
					<div class="message-content">
						{@html renderedStreaming}
						<span class="cursor"></span>
					</div>
				</div>
			{:else if isGenerating}
				<ThinkingIndicator />
			{/if}

			{#if contextNotice}
				<div class="notice">ⓘ {contextNotice}</div>
			{/if}
			{#if errorMessage}
				<div class="error-message">{errorMessage}</div>
			{/if}
		{:else}
			<div class="empty-state">
				<h2>Code</h2>
				{#if workingDir}
					<p>Working in <code>{workingDir}</code>.</p>
					<p>Ask the agent to explore, edit, run tests, or fix something.</p>
				{:else}
					<p>
						Choose a project directory to start. The agent reads, edits, and runs commands there.
					</p>
					<button class="cta" onclick={pickDirectory}>Choose project directory…</button>
				{/if}
			</div>
		{/if}
	</div>

	<div class="input-area">
		{#if isGenerating}
			<button class="stop-btn" onclick={() => cancelCodeGeneration()}>Stop</button>
		{/if}
		<div class="input-row">
			<textarea
				bind:value={inputText}
				onkeydown={handleKeydown}
				placeholder={workingDir ? 'Ask the coding agent…' : 'Choose a project directory first'}
				disabled={!workingDir}
				rows="1"
			></textarea>
			<button
				class="dir-btn"
				class:unset={!workingDir}
				onclick={pickDirectory}
				title={workingDir ?? 'Choose project directory'}
			>
				📁 {workingDir ? dirLabel : 'Choose…'}
			</button>
			<button
				class="clear-btn"
				onclick={() => clearCodeConversation()}
				disabled={isGenerating || messages.length === 0}
				title="Clear this conversation"
			>
				New
			</button>
			<button
				class="send-btn"
				onclick={handleSend}
				disabled={!inputText.trim() || isGenerating || !workingDir}
			>
				Send
			</button>
		</div>
	</div>
</div>

<style>
	.code-layout {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	.dir-btn {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		padding: 5px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		font-size: 0.85rem;
		cursor: pointer;
		white-space: nowrap;
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dir-btn.unset {
		border-color: var(--accent);
		color: var(--accent);
	}

	.clear-btn {
		padding: 5px 12px;
		border: 1px solid var(--border);
		border-radius: 8px;
		background: var(--bg-secondary);
		color: var(--text-secondary);
		font-size: 0.82rem;
		cursor: pointer;
	}

	.clear-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.messages {
		flex: 1;
		overflow-y: auto;
		position: relative;
	}

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

	.notice {
		padding: 12px 16px;
		color: var(--text-secondary);
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

	.empty-state {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-secondary);
		text-align: center;
		padding: 32px;
		gap: 6px;
	}

	.empty-state h2 {
		margin: 0 0 4px 0;
		color: var(--text-primary);
	}

	.empty-state code {
		font-size: 0.8rem;
		background: var(--bg-secondary);
		padding: 1px 5px;
		border-radius: 3px;
	}

	.cta {
		margin-top: 12px;
		padding: 8px 18px;
		background: var(--accent);
		color: white;
		border: none;
		border-radius: 8px;
		cursor: pointer;
		font-size: 0.9rem;
	}

	.input-area {
		border-top: 1px solid var(--border);
		padding: 12px 16px;
		background: var(--bg-primary);
		flex-shrink: 0;
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

	.send-btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
</style>
