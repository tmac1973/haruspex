<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings } from '$lib/stores/settings';

	interface Props {
		text: string;
	}

	let { text }: Props = $props();
	let playing = $state(false);
	let initializing = $state(false);

	async function toggleSpeak() {
		if (playing) {
			await invoke('tts_stop_playback');
			playing = false;
			return;
		}

		const initialized = await invoke<boolean>('tts_is_initialized');
		if (!initialized) {
			initializing = true;
			try {
				await invoke('tts_initialize');
			} catch (e) {
				console.error('TTS init failed:', e);
				initializing = false;
				return;
			}
			initializing = false;
		}

		playing = true;
		try {
			const settings = getSettings();
			const voice = settings.ttsVoice || undefined;
			const outputDevice = settings.audioOutputDevice || undefined;
			await invoke('tts_synthesize_and_play', { text, voice, outputDevice });
			const check = setInterval(async () => {
				const still = await invoke<boolean>('tts_is_playing');
				if (!still) {
					playing = false;
					clearInterval(check);
				}
			}, 500);
		} catch (e) {
			console.error('TTS failed:', e);
			playing = false;
		}
	}
</script>

<button
	class="speaker-btn"
	class:playing
	class:initializing
	onclick={toggleSpeak}
	title={initializing ? 'Loading voice...' : playing ? 'Stop reading' : 'Read aloud'}
>
	{#if initializing}
		<span class="spinner"></span>
	{:else}
		<svg
			width="14"
			height="14"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
		>
			{#if playing}
				<rect x="6" y="4" width="4" height="16"></rect>
				<rect x="14" y="4" width="4" height="16"></rect>
			{:else}
				<polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
				<path d="M19.07 4.93a10 10 0 0 1 0 14.14"></path>
				<path d="M15.54 8.46a5 5 0 0 1 0 7.07"></path>
			{/if}
		</svg>
	{/if}
</button>

<style>
	.speaker-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 4px 8px;
		border-radius: 4px;
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.75rem;
		transition: all 0.15s;
	}

	.speaker-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
	}

	.speaker-btn.playing {
		color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.spinner {
		width: 12px;
		height: 12px;
		border: 2px solid var(--border);
		border-top-color: var(--accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
