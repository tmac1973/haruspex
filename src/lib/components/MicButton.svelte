<script lang="ts">
	import {
		cancelVoiceCapture,
		getVoiceCaptureStatus,
		startVoiceCapture,
		stopAndTranscribe
	} from '$lib/audio/voiceCapture.svelte';

	interface Props {
		onTranscription: (text: string) => void;
		disabled?: boolean;
	}

	let { onTranscription, disabled = false }: Props = $props();

	const status = $derived(getVoiceCaptureStatus());
	const recording = $derived(status === 'recording');
	const processing = $derived(status === 'processing');
	const downloading = $derived(status === 'downloading');

	async function start() {
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
</script>

<div class="mic-container">
	<button
		class="mic-btn"
		class:recording
		class:processing={processing || downloading}
		disabled={disabled || downloading}
		aria-pressed={recording}
		onmousedown={start}
		onmouseup={stop}
		onmouseleave={cancel}
		onkeydown={onKeydown}
		onkeyup={onKeyup}
		onblur={cancel}
		title={downloading
			? 'Downloading speech model...'
			: recording
				? 'Release to send'
				: processing
					? 'Transcribing...'
					: 'Hold to talk (or hold F2)'}
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
	</button>
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
