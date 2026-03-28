<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';

	interface Props {
		text: string;
	}

	let { text }: Props = $props();
	let playing = $state(false);

	async function toggleSpeak() {
		if (playing) {
			await invoke('tts_stop_playback');
			playing = false;
			return;
		}

		// Initialize TTS engine on first use
		const initialized = await invoke<boolean>('tts_is_initialized');
		if (!initialized) {
			try {
				await invoke('tts_initialize');
			} catch (e) {
				console.error('TTS init failed:', e);
				return;
			}
		}

		playing = true;
		try {
			await invoke('tts_synthesize_and_play', { text });
			// Poll for completion
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
	onclick={toggleSpeak}
	title={playing ? 'Stop' : 'Read aloud'}
>
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
</button>

<style>
	.speaker-btn {
		background: none;
		border: none;
		color: var(--text-secondary);
		cursor: pointer;
		padding: 2px;
		border-radius: 3px;
		display: inline-flex;
		align-items: center;
		transition: color 0.15s;
	}

	.speaker-btn:hover {
		color: var(--text-primary);
	}

	.speaker-btn.playing {
		color: var(--accent);
	}
</style>
