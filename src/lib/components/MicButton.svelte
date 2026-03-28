<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	interface Props {
		onTranscription: (text: string) => void;
		disabled?: boolean;
	}

	let { onTranscription, disabled = false }: Props = $props();
	let recording = $state(false);
	let processing = $state(false);
	let error = $state<string | null>(null);

	type WhisperStatusResponse = 'Stopped' | 'Starting' | 'Ready' | { Error: string };

	function isReady(s: WhisperStatusResponse): boolean {
		return s === 'Ready';
	}

	function isError(s: WhisperStatusResponse): boolean {
		return typeof s === 'object' && 'Error' in s;
	}

	async function ensureWhisperReady(): Promise<boolean> {
		try {
			const status = await invoke<WhisperStatusResponse>('get_whisper_status');
			if (isReady(status)) return true;

			// Try to find the whisper model
			const modelsDir = await invoke<string>('get_models_dir');
			const whisperModel = `${modelsDir}/whisper/ggml-base.en.bin`;

			// Start whisper server
			await invoke('start_whisper', { modelPath: whisperModel });

			// Wait for ready (up to 15s)
			for (let i = 0; i < 30; i++) {
				await new Promise((r) => setTimeout(r, 500));
				const s = await invoke<WhisperStatusResponse>('get_whisper_status');
				if (isReady(s)) return true;
				if (isError(s)) return false;
			}
			return false;
		} catch (e) {
			console.error('Whisper setup failed:', e);
			return false;
		}
	}

	async function startRecording() {
		if (disabled || processing) return;
		error = null;
		try {
			await invoke('start_recording');
			recording = true;
		} catch (e) {
			error = `Mic error: ${e}`;
		}
	}

	async function stopRecording() {
		if (!recording) return;
		recording = false;
		processing = true;
		error = null;

		try {
			const audioData = await invoke<number[]>('stop_recording');

			// Ensure whisper is running
			const ready = await ensureWhisperReady();
			if (!ready) {
				error = 'Speech recognition not available. Download whisper model first.';
				processing = false;
				return;
			}

			const text = await invoke<string>('transcribe_audio', { audio: audioData });
			if (text && text.trim()) {
				onTranscription(text.trim());
			} else {
				error = 'No speech detected';
			}
		} catch (e) {
			error = `Transcription failed: ${e}`;
		} finally {
			processing = false;
		}
	}
</script>

<div class="mic-container">
	<button
		class="mic-btn"
		class:recording
		class:processing
		{disabled}
		onmousedown={startRecording}
		onmouseup={stopRecording}
		onmouseleave={() => {
			if (recording) stopRecording();
		}}
		title={recording ? 'Release to send' : processing ? 'Transcribing...' : 'Hold to record'}
	>
		{#if processing}
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
	{#if error}
		<span class="mic-error">{error}</span>
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
		background: #ef4444;
		border-color: #ef4444;
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

	.mic-error {
		font-size: 0.75rem;
		color: var(--error-text);
		max-width: 200px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.spinner {
		width: 14px;
		height: 14px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
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

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
