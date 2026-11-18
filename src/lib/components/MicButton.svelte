<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		cancelVoiceCapture,
		getPendingPhrases,
		getVoiceCaptureStatus,
		isListeningOwner,
		startListening,
		startVoiceCapture,
		stopAndTranscribe,
		stopListening,
		type DictationTarget
	} from '#lib/audio/voiceCapture.svelte.ts';

	interface Props {
		onTranscription: (text: string) => void;
		disabled?: boolean;
		/** The composer constant listening dictates into; without it there is no right-click menu. */
		dictation?: DictationTarget;
		/** The conversation or session the composer is for; listening stops when it changes. */
		contextKey?: string;
	}

	let { onTranscription, disabled = false, dictation, contextKey }: Props = $props();

	const ownerToken = Symbol('mic-button');

	const status = $derived(getVoiceCaptureStatus());
	const recording = $derived(status === 'recording');
	const processing = $derived(status === 'processing');
	const downloading = $derived(status === 'downloading');
	// This button's constant listening, as opposed to another composer's.
	const mine = $derived(
		(status === 'listening' || status === 'paused') && isListeningOwner(ownerToken)
	);
	const pending = $derived(mine && getPendingPhrases() > 0);

	async function start() {
		if (mine) {
			void stopListening();
			return;
		}
		if (disabled || status !== 'idle') return;
		await startVoiceCapture();
	}

	async function stop() {
		if (status !== 'recording') return;
		const text = await stopAndTranscribe();
		if (text) onTranscription(text);
	}

	// Backing out of the gesture (Esc, focus loss, pointer leaving the
	// button) aborts the recording without transcribing.
	function cancel() {
		if (recording) void cancelVoiceCapture();
	}

	// Hold-to-talk on the keyboard mirrors the mouse gesture: Space/Enter
	// down starts recording (the `repeat` guard ignores key auto-repeat
	// while held), key up stops and transcribes. Esc aborts. Both
	// preventDefault so the browser's synthetic button click never fires.
	function onKeydown(event: KeyboardEvent) {
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			if (!event.repeat) void start();
		} else if (event.key === 'Escape') {
			cancel();
		}
	}

	function onKeyup(event: KeyboardEvent) {
		if (event.key === ' ' || event.key === 'Enter') {
			event.preventDefault();
			void stop();
		}
	}

	// Right-click menu: constant listening, in place of the webview's own.
	let menu = $state<{ x: number; y: number } | null>(null);

	function openMenu(e: MouseEvent) {
		if (!dictation) return;
		e.preventDefault();
		menu = { x: e.clientX, y: e.clientY };
	}

	function closeMenu() {
		menu = null;
	}

	function toggleListening() {
		closeMenu();
		if (mine) void stopListening();
		else if (dictation && status === 'idle') void startListening(ownerToken, dictation);
	}

	// Switching conversation or session stops listening, so dictated text
	// never lands in the wrong composer.
	const UNSEEN = Symbol('unseen');
	let lastKey: string | undefined | typeof UNSEEN = UNSEEN;
	$effect(() => {
		const key = contextKey;
		if (lastKey !== UNSEEN && key !== lastKey && isListeningOwner(ownerToken)) {
			void stopListening();
		}
		lastKey = key;
	});

	onDestroy(() => {
		if (isListeningOwner(ownerToken)) void stopListening();
	});

	const title = $derived(
		downloading
			? 'Downloading speech model...'
			: mine && status === 'paused'
				? 'Paused while audio plays'
				: mine
					? 'Listening — click to stop. Say “send it” to send, “scratch that” to undo.'
					: recording
						? 'Release to send'
						: processing
							? 'Transcribing...'
							: dictation
								? 'Hold to talk (or hold F2) · right-click for constant listening'
								: 'Hold to talk (or hold F2)'
	);
</script>

<svelte:window
	onclick={closeMenu}
	onkeydown={(e) => e.key === 'Escape' && closeMenu()}
	onblur={closeMenu}
/>

<div class="mic-container">
	<button
		class="mic-btn"
		class:recording
		class:listening={mine && status === 'listening'}
		class:paused={mine && status === 'paused'}
		class:processing={processing || downloading}
		disabled={(disabled && !mine) || downloading}
		aria-pressed={recording || mine}
		onmousedown={(e) => e.button === 0 && void start()}
		onmouseup={(e) => e.button === 0 && void stop()}
		onmouseleave={cancel}
		onkeydown={onKeydown}
		onkeyup={onKeyup}
		onblur={cancel}
		oncontextmenu={openMenu}
		{title}
	>
		{#if processing || downloading}
			<span class="spinner"></span>
		{:else}
			<svg
				width="18"
				height="18"
				viewBox="0 0 24 24"
				fill="none"
				stroke="currentColor"
				stroke-width="2"
			>
				<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path>
				<path d="M19 10v2a7 7 0 0 1-14 0v-2"></path>
				<line x1="12" y1="19" x2="12" y2="23"></line>
				<line x1="8" y1="23" x2="16" y2="23"></line>
			</svg>
		{/if}
		{#if pending}
			<span class="pending-dot" aria-label="Transcribing"></span>
		{/if}
	</button>
	{#if menu}
		<div class="context-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu">
			<button
				role="menuitemcheckbox"
				aria-checked={mine}
				onclick={toggleListening}
				disabled={!mine && status !== 'idle'}
				title="Dictate into this box until you click the mic again. Say “send it” to send, “scratch that” to undo the last phrase."
			>
				<span class="check">{mine ? '✓' : ''}</span>Constant listening
			</button>
		</div>
	{/if}
</div>

<style>
	.mic-container {
		display: flex;
		align-items: center;
		gap: 8px;
		flex-shrink: 0;
	}

	.mic-btn {
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

	.mic-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.mic-btn.recording {
		background: var(--error-text);
		border-color: var(--error-text);
		color: white;
		animation: pulse-record 1s ease-in-out infinite;
	}

	/* Always-on listening: a steady accent ring that breathes, unlike the red
	   recording pulse. */
	.mic-btn.listening {
		position: relative;
		border-color: var(--accent);
		color: var(--accent);
		box-shadow: 0 0 0 2px var(--accent);
		animation: breathe-listen 2s ease-in-out infinite;
	}

	.mic-btn.paused {
		position: relative;
		border-color: var(--accent);
		color: var(--accent);
		box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
		opacity: 0.6;
	}

	.pending-dot {
		position: absolute;
		top: -2px;
		right: -2px;
		width: 10px;
		height: 10px;
		border-radius: 50%;
		border: 2px solid var(--accent);
		border-top-color: transparent;
		animation: spin-dot 0.8s linear infinite;
	}

	.context-menu {
		position: fixed;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 4px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
		z-index: 100;
		min-width: 170px;
		padding: 4px 0;
	}

	.context-menu button {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-primary);
		padding: 6px 14px;
		font-size: 0.8rem;
		width: 100%;
		text-align: left;
		cursor: pointer;
	}

	.context-menu button:hover:not(:disabled) {
		background: var(--bg-secondary);
	}

	.context-menu button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.check {
		display: inline-block;
		width: 1.2em;
	}

	@keyframes breathe-listen {
		0%,
		100% {
			box-shadow: 0 0 0 2px var(--accent);
		}
		50% {
			box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 45%, transparent);
		}
	}

	@keyframes spin-dot {
		to {
			transform: rotate(360deg);
		}
	}

	.mic-btn.processing {
		opacity: 0.7;
		cursor: wait;
	}

	.mic-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	@keyframes pulse-record {
		0%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(1.1);
		}
	}
</style>
