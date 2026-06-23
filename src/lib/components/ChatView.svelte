<script lang="ts">
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import ConversationSidebar from '$lib/components/ConversationSidebar.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import SearchStepComponent from '$lib/components/SearchStep.svelte';
	import SourceChip from '$lib/components/SourceChip.svelte';
	import MicButton from '$lib/components/MicButton.svelte';
	import WorkingDirButton from '$lib/components/WorkingDirButton.svelte';
	import StopIndicator from '$lib/components/StopIndicator.svelte';
	import { imageDropTarget } from '$lib/utils/imageDrop';
	import { messageText } from '$lib/api';
	import {
		getActiveConversation,
		getIsGenerating,
		getIsWaitingForSlot,
		getIsCompacting,
		getContextNotice,
		getStreamingContent,
		getErrorMessage,
		getErrorTurnId,
		getSearchSteps,
		getSourceUrls,
		getExhaustiveResearch,
		renderStreamingHtml,
		setExhaustiveResearch,
		createConversation,
		sendMessage,
		continueTurn,
		cancelGeneration
	} from '$lib/stores/chat.svelte';
	import { getServerState, startServer, stopServer } from '$lib/stores/server.svelte';
	import {
		getActiveLocalModelFilename,
		getSettings,
		setActiveLocalModel
	} from '$lib/stores/settings';
	import { getDebugLogsForTurn } from '$lib/debug-log';
	import { createCopyAction } from '$lib/utils/clipboard.svelte';
	import { imageFileToDataUrl, imageFilesFrom } from '$lib/utils/image';
	import { invoke } from '@tauri-apps/api/core';
	import { onMount, onDestroy, tick, untrack } from 'svelte';

	let inputText = $state('');
	let messagesContainer: HTMLDivElement | undefined = $state();
	let autoScroll = $state(true);
	let showScrollButton = $state(false);
	// Images the user has attached (drag-drop / paste) for the next message.
	let pendingImages = $state<{ id: number; url: string }[]>([]);
	let imgSeq = 0;
	let dragOver = $state(false);

	async function addImageFiles(files: File[]) {
		for (const f of files) {
			try {
				const url = await imageFileToDataUrl(f);
				pendingImages = [...pendingImages, { id: imgSeq++, url }];
			} catch (e) {
				console.error('image attach failed', e);
			}
		}
	}

	function removeImage(id: number) {
		pendingImages = pendingImages.filter((p) => p.id !== id);
	}

	function onComposerPaste(e: ClipboardEvent) {
		const files = imageFilesFrom(e.clipboardData);
		if (files.length) {
			e.preventDefault();
			void addImageFiles(files);
		}
	}

	/** Attach already-encoded image data URLs (from a native file drop). */
	function addImageUrls(urls: string[]) {
		pendingImages = [...pendingImages, ...urls.map((url) => ({ id: imgSeq++, url }))];
	}

	/** Single send path for the button, Enter, and voice — folds in any
	 *  attached images and clears the composer. */
	async function doSend(text: string) {
		const images = pendingImages.map((p) => p.url);
		if ((!text.trim() && images.length === 0) || isGenerating || isCompacting) return;
		inputText = '';
		pendingImages = [];
		autoScroll = true;
		await sendMessage(text, images);
	}

	const copyDebugLog = createCopyAction();

	function copyDebugLogForError() {
		if (errorTurnId == null) return;
		copyDebugLog.copy(() => {
			const lines = getDebugLogsForTurn(errorTurnId!);
			if (lines.length === 0) throw new Error('no debug logs for this turn');
			return lines.join('\n');
		});
	}

	const activeConversation = $derived(getActiveConversation());
	const isGenerating = $derived(getIsGenerating());
	const isWaitingForSlot = $derived(getIsWaitingForSlot());
	const isCompacting = $derived(getIsCompacting());
	const contextNotice = $derived(getContextNotice());
	const streamingContent = $derived(getStreamingContent());
	const errorMessage = $derived(getErrorMessage());
	const errorTurnId = $derived(getErrorTurnId());
	const searchSteps = $derived(getSearchSteps());
	const sourceUrls = $derived(getSourceUrls());
	const serverState = $derived(getServerState());

	// Chat is usable whenever a backend is ready to take requests. That
	// means either the local sidecar reached the 'ready' state or the
	// user is in remote-inference mode (which assumes the remote server
	// is up — we don't health-check on every keystroke).
	const serverReady = $derived(serverState.status === 'ready' || serverState.status === 'remote');
	const exhaustiveResearch = $derived(getExhaustiveResearch());

	// Slow-mode notice fires when deep research is on, the user is using
	// auto-rotation across free public engines, and they don't have a Brave
	// API key configured. In that combination the search proxy paces itself
	// to avoid bot-detection trips, which makes deep research noticeably
	// slower — the user should know why.
	const searchProviderSlowMode = $derived(
		exhaustiveResearch && getSettings().searchProvider === 'auto' && !getSettings().braveApiKey
	);

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
		await doSend(inputText);
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

	// Throttle streaming markdown rendering.
	//
	// Re-parsing the full accumulated stream buffer on every chunk (through
	// marked + highlight.js + the table fixer) is O(N) in content length and
	// gets called 10-30x/s during fast streaming. For long research reports
	// that's enough to peg the main thread and freeze the UI. Instead of
	// rendering on every chunk we flush at most once every STREAM_RENDER_MS,
	// which caps the parse cost to a few frames per second. The first chunk
	// still renders immediately so there's no perceptible lag at the start,
	// and the final flush happens via the normal onComplete → streamingContent
	// = '' path so the last state is always current.
	const STREAM_RENDER_MS = 150;
	let throttledStreamingContent = $state('');
	let streamRenderTimer: ReturnType<typeof setTimeout> | null = null;

	$effect(() => {
		// Track streamingContent reactively; everything else is untracked.
		const current = streamingContent;
		untrack(() => {
			if (!current) {
				// Stream ended — drop the preview and cancel any pending flush.
				throttledStreamingContent = '';
				if (streamRenderTimer !== null) {
					clearTimeout(streamRenderTimer);
					streamRenderTimer = null;
				}
			} else if (!throttledStreamingContent) {
				// First chunk: render immediately so the cursor shows up fast.
				throttledStreamingContent = current;
			} else if (streamRenderTimer === null) {
				// Subsequent chunks: coalesce into one render per window.
				streamRenderTimer = setTimeout(() => {
					throttledStreamingContent = getStreamingContent();
					streamRenderTimer = null;
				}, STREAM_RENDER_MS);
			}
		});
	});

	onDestroy(() => {
		if (streamRenderTimer !== null) {
			clearTimeout(streamRenderTimer);
			streamRenderTimer = null;
		}
	});

	const renderedStreamingContent = $derived(renderStreamingHtml(throttledStreamingContent));

	// Single-source diversity warning: when the just-completed assistant
	// message has several inline [N] citations but they all collapse to
	// the same URL, the model likely tagged every claim with the same
	// "[source]" marker regardless of where the claim actually came from.
	// The banner tells the reader to be skeptical about specifics without
	// second-guessing the whole answer.
	const lastAssistantContent = $derived.by(() => {
		const msgs = activeConversation?.messages;
		if (!msgs) return '';
		for (let i = msgs.length - 1; i >= 0; i--) {
			if (msgs[i].role === 'assistant') return messageText(msgs[i].content);
		}
		return '';
	});
	const inlineCitationCount = $derived(
		(lastAssistantContent.match(/\[\\\[\d+\\\]\]/g) || []).length
	);
	const showDiversityWarning = $derived(
		!isGenerating && sourceUrls.length === 1 && inlineCitationCount >= 3
	);

	// CPU-fallback banner state. Hidden in remote mode (the message
	// "running on CPU" doesn't apply when chat is going to a remote
	// server) and once the user explicitly dismisses the current notice.
	//
	// Dismissal is keyed on the *reason* string so that:
	//   - Re-running the exact same failing start (same VRAM error)
	//     stays dismissed — the user already saw it and chose to keep
	//     working on CPU.
	//   - A different GPU error in the same session re-shows the banner
	//     since it carries new information.
	//   - A successful restart clears `cpuFallback` entirely; the effect
	//     below resets `dismissedReason` so any subsequent fallback in
	//     the session shows the banner again from scratch.
	let dismissedReason = $state<string | null>(null);
	$effect(() => {
		if (!serverState.cpuFallback) {
			dismissedReason = null;
		}
	});
	const showCpuFallbackBanner = $derived(
		serverState.status !== 'remote' &&
			!!serverState.cpuFallback &&
			serverState.cpuFallback.reason !== dismissedReason
	);
	let restartingOnGpu = $state(false);

	function dismissCpuFallback() {
		dismissedReason = serverState.cpuFallback?.reason ?? null;
	}

	async function restartOnGpu() {
		if (restartingOnGpu || isGenerating) return;
		restartingOnGpu = true;
		try {
			const modelPath = await invoke<string | null>('get_active_model_path', {
				preferredFilename: getActiveLocalModelFilename() || null
			});
			if (!modelPath) {
				console.warn('No active model — cannot restart on GPU');
				return;
			}
			setActiveLocalModel(modelPath);
			await stopServer();
			await startServer(modelPath, getSettings().contextSize);
		} catch (e) {
			console.error('Restart on GPU failed:', e);
		} finally {
			restartingOnGpu = false;
		}
	}
</script>

<div class="chat-layout">
	<ConversationSidebar />

	<div class="chat-main">
		{#if showCpuFallbackBanner}
			<div class="cpu-fallback-banner" role="alert">
				<div class="cpu-fallback-text">
					<strong>Running on CPU</strong> — the GPU couldn't load the model, so output will be much
					slower than usual. Free some VRAM (close other GPU apps) and retry.
					<details class="cpu-fallback-details">
						<summary>Show error</summary>
						<code>{serverState.cpuFallback?.reason}</code>
					</details>
				</div>
				<div class="cpu-fallback-actions">
					<button
						class="cpu-fallback-retry"
						onclick={restartOnGpu}
						disabled={restartingOnGpu || isGenerating}
					>
						{restartingOnGpu ? 'Restarting…' : 'Restart on GPU'}
					</button>
					<button
						class="cpu-fallback-dismiss"
						onclick={dismissCpuFallback}
						title="Hide this notice for the rest of the session"
					>
						Dismiss
					</button>
				</div>
			</div>
		{/if}
		<div class="messages" bind:this={messagesContainer} onscroll={handleScroll}>
			{#if activeConversation && activeConversation.messages.length > 0}
				{#each activeConversation.messages as msg, i (i)}
					{#if msg.role !== 'system'}
						{#if msg.role === 'assistant' && activeConversation.messageSteps[i]?.length}
							<SearchStepComponent steps={activeConversation.messageSteps[i]} />
						{/if}
						<ChatMessage
							message={msg}
							tokensPerSecond={activeConversation.messageStats?.[i]?.tokensPerSecond}
						/>
						{#if activeConversation.messageStops?.[i]}
							<StopIndicator
								reason={activeConversation.messageStops[i]}
								disabled={isGenerating || isCompacting}
								onContinue={continueTurn}
							/>
						{/if}
					{/if}
				{/each}

				{#if searchSteps.length > 0}
					<SearchStepComponent steps={searchSteps} slowMode={searchProviderSlowMode} />
				{/if}

				{#if isWaitingForSlot}
					<div class="compacting-indicator">Waiting for another inference request to finish…</div>
				{:else if isGenerating && streamingContent}
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

				{#if isCompacting}
					<div class="compacting-indicator">Compacting conversation history...</div>
				{/if}

				{#if contextNotice}
					<div class="compacting-indicator">ⓘ {contextNotice}</div>
				{/if}

				{#if activeConversation?.isRestoringSession}
					<div class="compacting-indicator">Restoring Python sandbox session…</div>
				{:else if activeConversation?.sessionRestoreSkipped}
					<div class="compacting-indicator">
						Python sandbox state was not restored (too many prior code runs). The model starts
						fresh.
					</div>
				{/if}

				{#if showDiversityWarning}
					<div class="diversity-warning">
						Model cited one source for multiple claims — treat specifics skeptically.
					</div>
				{/if}

				{#if sourceUrls.length > 0 && !isGenerating}
					<SourceChip urls={sourceUrls} />
				{/if}

				{#if errorMessage}
					<div class="error-message">
						<p>{errorMessage}</p>
						{#if errorTurnId != null}
							<button
								class="copy-debug-btn"
								onclick={copyDebugLogForError}
								title="Copy the debug log for just this failed turn"
							>
								{#if copyDebugLog.state === 'copied'}
									Copied!
								{:else if copyDebugLog.state === 'failed'}
									Nothing to copy
								{:else}
									Copy debug log
								{/if}
							</button>
						{/if}
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

		<div
			class="input-area"
			class:drag-over={dragOver}
			use:imageDropTarget={{ onImages: addImageUrls, onDragChange: (over) => (dragOver = over) }}
		>
			{#if isGenerating}
				<button class="stop-btn" onclick={() => cancelGeneration()}>Stop generating</button>
			{/if}
			{#if pendingImages.length}
				<div class="attachments">
					{#each pendingImages as img (img.id)}
						<div class="attachment">
							<img src={img.url} alt="attachment" />
							<button class="remove" title="Remove image" onclick={() => removeImage(img.id)}
								>×</button
							>
						</div>
					{/each}
				</div>
			{/if}
			<div class="input-row">
				<textarea
					bind:value={inputText}
					onkeydown={handleKeydown}
					onpaste={onComposerPaste}
					placeholder={serverReady
						? 'Type a message… (drop or paste an image to attach)'
						: 'Waiting for model to load...'}
					disabled={!serverReady && !activeConversation}
					rows="1"
				></textarea>
				<WorkingDirButton />
				<button
					class="research-toggle"
					class:active={exhaustiveResearch}
					onclick={() => setExhaustiveResearch(!exhaustiveResearch)}
					title={exhaustiveResearch
						? 'Deep research ON — will search more sources'
						: 'Deep research OFF — normal search'}
				>
					<svg
						width="18"
						height="18"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						stroke-width="2"
						stroke-linecap="round"
						stroke-linejoin="round"
					>
						<circle cx="11" cy="11" r="8"></circle>
						<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
						{#if exhaustiveResearch}
							<line x1="11" y1="8" x2="11" y2="14"></line>
							<line x1="8" y1="11" x2="14" y2="11"></line>
						{/if}
					</svg>
				</button>
				<MicButton
					onTranscription={async (text) => {
						await doSend(text);
					}}
					disabled={isGenerating || isCompacting}
				/>
				<button
					class="send-btn"
					onclick={handleSend}
					disabled={(!inputText.trim() && pendingImages.length === 0) ||
						isGenerating ||
						isCompacting}
				>
					Send
				</button>
			</div>
		</div>
	</div>
</div>

<style>
	.chat-layout {
		display: flex;
		flex: 1;
		min-height: 0;
		overflow: hidden;
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

	.copy-debug-btn {
		margin-top: 8px;
		background: transparent;
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 4px;
		padding: 3px 10px;
		font-size: 0.75rem;
		cursor: pointer;
	}

	.copy-debug-btn:hover {
		background: color-mix(in srgb, var(--error-text) 10%, transparent);
	}

	.compacting-indicator {
		padding: 12px 16px;
		color: var(--text-secondary);
		font-size: 0.85rem;
		font-style: italic;
	}

	.diversity-warning {
		margin: 4px 16px 0;
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-left: 3px solid var(--text-secondary);
		border-radius: 4px;
		color: var(--text-secondary);
		font-size: 0.78rem;
		line-height: 1.4;
	}

	.cpu-fallback-banner {
		display: flex;
		align-items: flex-start;
		gap: 12px;
		margin: 8px 16px 0;
		padding: 10px 14px;
		border: 1px solid var(--border);
		border-left: 3px solid #c69300;
		border-radius: 6px;
		background: color-mix(in srgb, #c69300 6%, var(--bg-primary));
		color: var(--text-primary);
		font-size: 0.82rem;
		line-height: 1.45;
	}

	.cpu-fallback-text {
		flex: 1;
		min-width: 0;
	}

	.cpu-fallback-details {
		margin-top: 6px;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.cpu-fallback-details summary {
		cursor: pointer;
		user-select: none;
	}

	.cpu-fallback-details code {
		display: block;
		margin-top: 4px;
		padding: 6px 8px;
		background: var(--code-bg, var(--bg-secondary));
		border-radius: 4px;
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
		font-size: 0.72rem;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.cpu-fallback-actions {
		display: flex;
		flex-direction: column;
		gap: 6px;
		flex-shrink: 0;
	}

	.cpu-fallback-retry {
		padding: 6px 14px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-primary);
		font-size: 0.78rem;
		font-weight: 500;
	}

	.cpu-fallback-retry:hover:not(:disabled) {
		border-color: #c69300;
	}

	.cpu-fallback-retry:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.cpu-fallback-dismiss {
		padding: 4px 14px;
		background: none;
		border: 1px solid transparent;
		border-radius: 6px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.75rem;
	}

	.cpu-fallback-dismiss:hover {
		color: var(--text-primary);
		border-color: var(--border);
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
	.input-area.drag-over {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-primary));
		outline: 2px dashed var(--accent);
		outline-offset: -4px;
	}
	.attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin-bottom: 8px;
	}
	.attachment {
		position: relative;
		width: 64px;
		height: 64px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--border);
	}
	.attachment img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.attachment .remove {
		position: absolute;
		top: 1px;
		right: 1px;
		width: 18px;
		height: 18px;
		line-height: 16px;
		padding: 0;
		border: none;
		border-radius: 4px;
		background: rgba(0, 0, 0, 0.6);
		color: white;
		font-size: 14px;
		cursor: pointer;
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

	.research-toggle {
		width: 40px;
		height: 40px;
		border-radius: 50%;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-secondary);
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
		transition: all 0.15s;
	}

	.research-toggle:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.research-toggle.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}
</style>
