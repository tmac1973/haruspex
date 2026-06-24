<script lang="ts">
	import { onMount } from 'svelte';
	import ChatMessage from '$lib/components/ChatMessage.svelte';
	import StopIndicator from '$lib/components/StopIndicator.svelte';
	import { imageDropTarget } from '$lib/utils/imageDrop';
	import MicButton from '$lib/components/MicButton.svelte';
	import SearchStepComponent from '$lib/components/SearchStep.svelte';
	import ThinkingIndicator from '$lib/components/ThinkingIndicator.svelte';
	import {
		messageText,
		type ChatMessage as ChatMessageType,
		type MessageContentPart
	} from '$lib/api';
	import { getSettings, updateSettings } from '$lib/stores/settings';
	import { imageFileToDataUrl, imageFilesFrom } from '$lib/utils/image';

	const SHELL_PREAMBLE_MARKER = 'Recent shell activity (oldest first):';
	const SHELL_PREAMBLE_SEP = '\n\n---\n\n';

	interface SplitMessage {
		preamble: string | null;
		question: string;
	}

	function splitShellPreamble(content: string): SplitMessage {
		if (!content.startsWith(SHELL_PREAMBLE_MARKER)) {
			return { preamble: null, question: content };
		}
		const sepIdx = content.indexOf(SHELL_PREAMBLE_SEP);
		if (sepIdx < 0) {
			return { preamble: null, question: content };
		}
		return {
			preamble: content.slice(0, sepIdx),
			question: content.slice(sepIdx + SHELL_PREAMBLE_SEP.length)
		};
	}

	function userMessageView(msg: ChatMessageType): SplitMessage {
		return splitShellPreamble(messageText(msg.content));
	}

	/** Image parts of a (possibly multimodal) user message. */
	function imagePartsOf(content: ChatMessageType['content']): MessageContentPart[] {
		return typeof content === 'string' ? [] : content.filter((p) => p.type === 'image_url');
	}

	/** Rebuild a user message for display with the preamble stripped but any
	 *  attached images preserved (the preamble split works on text only). */
	function userQuestionMessage(msg: ChatMessageType, question: string): ChatMessageType {
		const imgs = imagePartsOf(msg.content);
		if (!imgs.length) return { ...msg, content: question };
		return {
			...msg,
			content: [...(question.trim() ? [{ type: 'text' as const, text: question }] : []), ...imgs]
		};
	}

	function preambleSummary(preamble: string): string {
		const lines = preamble.split('\n').length;
		// Count "$ " command lines as a proxy for how many shell commands
		// landed in the preamble — shows up nicer than raw lines.
		const cmdLines = preamble.split('\n').filter((l) => l.startsWith('$ ')).length;
		return cmdLines > 0
			? `Attached: ${cmdLines} shell command${cmdLines === 1 ? '' : 's'} (${lines} lines)`
			: `Attached: ${lines} lines of shell context`;
	}

	// The preamble <pre> is a fixed-height scroll box; when its content is
	// taller than the box AND the user hasn't scrolled to the bottom, mark
	// the wrapper so a "scroll for more" fade appears. Without this cue the
	// clipped content reads as missing rather than scrollable.
	function overflowFade(node: HTMLElement) {
		const wrap = node.parentElement;
		const update = () => {
			if (!wrap) return;
			const clipped =
				node.scrollHeight > node.clientHeight + 1 &&
				node.scrollTop + node.clientHeight < node.scrollHeight - 1;
			wrap.classList.toggle('clipped', clipped);
		};
		update();
		node.addEventListener('scroll', update, { passive: true });
		const ro = new ResizeObserver(update);
		ro.observe(node);
		return {
			destroy() {
				node.removeEventListener('scroll', update);
				ro.disconnect();
			}
		};
	}
	import type { ShellSession } from '$lib/stores/shell.svelte';

	const { session }: { session: ShellSession } = $props();

	const open = $derived(session.sidebarOpen);
	const messages = $derived(session.messages);
	const streaming = $derived(session.streamingContent);
	const submitting = $derived(session.isSubmitting);
	const ticket = $derived(session.ticket);
	const lastError = $derived(session.lastError);
	const contextNotice = $derived(session.contextNotice);
	const searchSteps = $derived(session.searchSteps);
	const messageSteps = $derived(session.messageSteps);
	const messageStats = $derived(session.messageStats);
	const messageStops = $derived(session.messageStops);
	const markerCount = $derived(session.integrationMarkerCount);
	const completedCommands = $derived(session.integrationCompletedCommands);
	const codeMode = $derived(session.codeMode);
	const thinkingEnabled = $derived(session.thinkingEnabled);
	// Three-state badge:
	//   - red "no integration"    : marker_count is 0 → hook didn't load
	//   - amber "no captures yet"  : markers exist but no B→C→D cycles → user
	//                                hasn't run anything in this session yet
	//   - green "N captures"       : completed commands are available; the
	//                                auto-attach will include them
	const integrationState = $derived<'red' | 'amber' | 'green'>(
		markerCount === 0 ? 'red' : completedCommands === 0 ? 'amber' : 'green'
	);
	const integrationLabel = $derived(
		integrationState === 'red'
			? '● no integration'
			: integrationState === 'amber'
				? '● no captures yet'
				: `● ${completedCommands} capture${completedCommands === 1 ? '' : 's'}`
	);
	const integrationTooltip = $derived(
		integrationState === 'red'
			? 'Shell integration NOT detected. Right-click the terminal and pick Restart shell, then run a command. If that still shows 0, the bash hook script is not loading.'
			: integrationState === 'amber'
				? 'OSC 133 hook is loaded but no commands have completed in this session yet. Run something in the terminal — the auto-attach uses completed B→C→D cycles, not just the prompt redraws.'
				: `${completedCommands} completed command${completedCommands === 1 ? '' : 's'} available — the auto-attach will include up to ${completedCommands < 10 ? completedCommands : 10} of them in your next message (configurable in Settings → Shell).`
	);
	// Refresh the status while the sidebar is open so the badge tracks
	// captures as the user runs commands. 2 s is enough to feel live
	// without thrashing the Tauri IPC.
	$effect(() => {
		if (!open) return;
		const id = setInterval(() => void session.refreshIntegrationStatus(), 2000);
		return () => clearInterval(id);
	});

	let composerText = $state('');
	let composerEl = $state<HTMLTextAreaElement | null>(null);
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

	/** Single send path (button, Enter, voice) — folds in attached images. */
	async function doSend(text: string) {
		const images = pendingImages.map((p) => p.url);
		if ((!text.trim() && images.length === 0) || submitting) return;
		composerText = '';
		pendingImages = [];
		autosize();
		await session.submitChatMessage(text, images);
	}
	let threadEl = $state<HTMLDivElement | null>(null);
	const MIN_WIDTH = 320;
	function maxWidth(): number {
		// Leave at least 320 px for the terminal so the user can still
		// see what they're typing while the sidebar is dragged wide.
		return Math.max(MIN_WIDTH, window.innerWidth - 320);
	}

	// Clamp the saved width to the current window so a sidebar sized in a wide
	// main window doesn't swamp a narrower (e.g. detached) one on first paint.
	let sidebarWidth = $state(Math.min(getSettings().shellSidebarWidth, maxWidth()));

	function startResize(event: MouseEvent) {
		event.preventDefault();
		const startX = event.clientX;
		const startWidth = sidebarWidth;
		document.body.style.cursor = 'col-resize';
		document.body.style.userSelect = 'none';

		function onMove(e: MouseEvent) {
			// Sidebar is on the right; dragging the handle left widens it.
			const delta = startX - e.clientX;
			sidebarWidth = Math.max(MIN_WIDTH, Math.min(maxWidth(), startWidth + delta));
		}
		function onUp() {
			window.removeEventListener('mousemove', onMove);
			window.removeEventListener('mouseup', onUp);
			document.body.style.cursor = '';
			document.body.style.userSelect = '';
			updateSettings({ shellSidebarWidth: sidebarWidth });
		}
		window.addEventListener('mousemove', onMove);
		window.addEventListener('mouseup', onUp);
	}

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
		await doSend(composerText);
	}

	function onComposerKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			handleSend();
		}
		if (event.key === 'Escape' && submitting) {
			event.preventDefault();
			session.cancelTurn();
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
		session.bindComposer(() => composerEl?.focus());
		return () => session.unbindComposer();
	});
</script>

{#if open}
	<aside class="sidebar" style="width: {sidebarWidth}px" aria-label="LLM troubleshooting assistant">
		<button
			class="resize-handle"
			onmousedown={startResize}
			aria-label="Drag to resize sidebar"
			title="Drag to resize"
		></button>
		<header>
			<h3>Assistant</h3>
			<div class="actions">
				<span
					class="integration-badge"
					class:bad={integrationState === 'red'}
					class:warn={integrationState === 'amber'}
					class:good={integrationState === 'green'}
					title={integrationTooltip}
				>
					{integrationLabel}
				</span>
				<button
					class="toggle"
					class:active={codeMode}
					onclick={session.toggleCodeMode}
					disabled={submitting}
					title={codeMode
						? 'Code mode ON — coding tools; the agent runs commands in this terminal'
						: 'Code mode OFF — shell troubleshooting assistant'}
				>
					Code
				</button>
				<button
					class="toggle"
					class:active={thinkingEnabled}
					onclick={session.toggleThinking}
					disabled={submitting}
					title={thinkingEnabled
						? 'Reasoning ON — the model thinks before acting'
						: 'Reasoning OFF — the model acts immediately'}
				>
					Think
				</button>
				<button onclick={session.newChat} disabled={submitting} title="Clear chat">New chat</button>
				<button onclick={session.toggleSidebar} title="Collapse">›</button>
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
				<!-- Tool-call placeholders (assistant msgs with tool_calls + empty
				     content) and tool results are kept in the thread so the model
				     replays its own work across turns, but they render as the
				     SearchStep rows above, not as their own (empty) bubbles. -->
				{#if msg.role !== 'tool' && !msg.tool_calls}
					{#if msg.role === 'assistant' && messageSteps[i]?.length}
						<SearchStepComponent steps={messageSteps[i]} />
					{/if}
					{#if msg.role === 'user'}
						{@const split = userMessageView(msg)}
						{#if split.preamble}
							<details class="shell-preamble">
								<summary>{preambleSummary(split.preamble)}</summary>
								<div class="preamble-scroll">
									<pre use:overflowFade>{split.preamble}</pre>
								</div>
							</details>
							{#if split.question.trim() || imagePartsOf(msg.content).length}
								<ChatMessage message={userQuestionMessage(msg, split.question)} />
							{/if}
						{:else}
							<ChatMessage message={msg} />
						{/if}
					{:else}
						<ChatMessage message={msg} tokensPerSecond={messageStats[i]?.tokensPerSecond} />
						{#if messageStops[i]}
							<StopIndicator
								reason={messageStops[i]}
								disabled={submitting}
								onContinue={session.continueTurn}
							/>
						{/if}
					{/if}
				{/if}
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
			{#if contextNotice}
				<div class="context-notice">ⓘ {contextNotice}</div>
			{/if}
			{#if lastError}
				<div class="error">{lastError}</div>
			{/if}
		</div>
		<footer
			class="composer"
			class:drag-over={dragOver}
			use:imageDropTarget={{ onImages: addImageUrls, onDragChange: (over) => (dragOver = over) }}
		>
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
			<textarea
				bind:this={composerEl}
				bind:value={composerText}
				oninput={onComposerInput}
				onkeydown={onComposerKeydown}
				onpaste={onComposerPaste}
				onfocus={() => session.setComposerFocused(true)}
				onblur={() => session.setComposerFocused(false)}
				placeholder="Ask the assistant… (Enter to send; drop or paste an image to attach)"
				rows="1"
				disabled={submitting}
			></textarea>
			<button
				class="ctx-btn"
				onclick={() => session.submitRecentCommands()}
				disabled={submitting}
				title="Submit recent shell commands & output, no prompt (F4)"
				aria-label="Submit recent shell commands"
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
					<polyline points="4 17 10 11 4 5"></polyline>
					<line x1="12" y1="19" x2="20" y2="19"></line>
				</svg>
			</button>
			<MicButton onTranscription={(text) => doSend(text)} disabled={submitting} />
			{#if submitting}
				<button class="cancel" onclick={session.cancelTurn} title="Cancel (Esc)">Stop</button>
			{:else}
				<button
					class="send"
					onclick={handleSend}
					disabled={!composerText.trim() && pendingImages.length === 0}
					title="Send (Enter)">Send</button
				>
			{/if}
		</footer>
	</aside>
{:else}
	<button
		class="rail"
		onclick={session.toggleSidebar}
		title="Open assistant"
		aria-label="Open assistant sidebar"
	>
		<span class="rail-glyph">‹</span>
		<span class="rail-label">Assistant</span>
	</button>
{/if}

<style>
	.sidebar {
		position: relative;
		display: flex;
		flex-direction: column;
		min-width: 320px;
		border-left: 1px solid var(--border);
		background: var(--bg-primary);
		flex-shrink: 0;
		min-height: 0;
	}

	.resize-handle {
		position: absolute;
		left: -3px;
		top: 0;
		bottom: 0;
		width: 6px;
		background: transparent;
		border: 0;
		cursor: col-resize;
		z-index: 5;
		padding: 0;
	}

	.resize-handle:hover,
	.resize-handle:active {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
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
		gap: 6px;
		align-items: center;
	}

	.integration-badge {
		font-size: 0.7rem;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
		padding: 2px 6px;
		border-radius: 999px;
		border: 1px solid var(--border);
		cursor: help;
	}

	.integration-badge.good {
		color: #4ade80;
		border-color: color-mix(in srgb, #4ade80 35%, transparent);
		background: color-mix(in srgb, #4ade80 10%, transparent);
	}

	.integration-badge.warn {
		color: #f59e0b;
		border-color: color-mix(in srgb, #f59e0b 35%, transparent);
		background: color-mix(in srgb, #f59e0b 10%, transparent);
	}

	.integration-badge.bad {
		color: var(--error-text, #c66);
		border-color: color-mix(in srgb, var(--error-text, #c66) 35%, transparent);
		background: color-mix(in srgb, var(--error-text, #c66) 10%, transparent);
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

	.actions button.toggle.active {
		background: color-mix(in srgb, var(--accent) 18%, transparent);
		border-color: var(--accent);
		color: var(--accent);
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

	.context-notice {
		font-size: 0.78rem;
		color: var(--text-secondary);
		font-style: italic;
		padding: 6px 4px;
	}

	.shell-preamble {
		margin: 6px 0 2px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.78rem;
	}

	.shell-preamble summary {
		padding: 6px 10px;
		cursor: pointer;
		color: var(--text-secondary);
		user-select: none;
		list-style: none;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.shell-preamble summary::before {
		content: '▸';
		display: inline-block;
		transition: transform 0.12s ease;
		color: var(--text-secondary);
		font-size: 0.7rem;
	}

	.shell-preamble[open] summary::before {
		transform: rotate(90deg);
	}

	.shell-preamble summary:hover {
		color: var(--text-primary);
	}

	.preamble-scroll {
		position: relative;
	}

	/* "Scroll for more" cue: a fade + chevron pinned to the bottom of the
	   scroll box, shown only while content is clipped below the fold. */
	.preamble-scroll:global(.clipped)::after {
		content: '⌄ more';
		position: absolute;
		left: 1px;
		right: 1px;
		bottom: 0;
		padding: 14px 0 3px;
		text-align: center;
		font-size: 0.62rem;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
		pointer-events: none;
		border-radius: 0 0 6px 6px;
		background: linear-gradient(to bottom, transparent, var(--bg-secondary) 65%);
	}

	.shell-preamble pre {
		margin: 0;
		padding: 8px 12px 10px;
		border-top: 1px solid var(--border);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace;
		font-size: 0.75rem;
		line-height: 1.4;
		color: var(--text-primary);
		overflow-x: auto;
		white-space: pre-wrap;
		word-break: break-word;
		max-height: 360px;
		overflow-y: auto;
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
		flex-wrap: wrap;
		gap: 6px;
		align-items: flex-end;
		padding: 8px 10px;
		border-top: 1px solid var(--border);
		flex-shrink: 0;
	}
	.composer.drag-over {
		background: color-mix(in srgb, var(--accent) 12%, var(--bg-primary));
		outline: 2px dashed var(--accent);
		outline-offset: -4px;
	}
	.composer .attachments {
		display: flex;
		flex-wrap: wrap;
		gap: 6px;
		width: 100%;
	}
	.composer .attachment {
		position: relative;
		width: 56px;
		height: 56px;
		border-radius: 6px;
		overflow: hidden;
		border: 1px solid var(--border);
	}
	.composer .attachment img {
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
	.composer .attachment .remove {
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

	.ctx-btn {
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

	.ctx-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.ctx-btn:disabled {
		opacity: 0.4;
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
