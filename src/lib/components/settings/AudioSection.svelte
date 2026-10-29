<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { TTS_VOICES } from '#lib/audio/voices.ts';

	const voiceOptions = TTS_VOICES;

	let ttsVoice = $state(getSettings().ttsVoice);
	let ttsReadTablesByColumn = $state(getSettings().ttsReadTablesByColumn);
	let outputDevices = $state<string[]>(['System Default']);
	let inputDevices = $state<string[]>(['System Default']);
	let audioOutputDevice = $state(getSettings().audioOutputDevice || 'System Default');
	let audioInputDevice = $state(getSettings().audioInputDevice || 'System Default');

	function setTtsVoice(voice: string) {
		ttsVoice = voice;
		updateSettings({ ttsVoice: voice });
	}

	function toggleTableReading() {
		ttsReadTablesByColumn = !ttsReadTablesByColumn;
		updateSettings({ ttsReadTablesByColumn });
	}

	async function refreshOutputDevices() {
		try {
			outputDevices = await invoke<string[]>('list_audio_output_devices');
		} catch {
			// ignore
		}
	}

	async function refreshInputDevices() {
		try {
			inputDevices = await invoke<string[]>('list_audio_input_devices');
		} catch {
			// ignore
		}
	}

	function setOutputDevice(device: string) {
		audioOutputDevice = device;
		updateSettings({ audioOutputDevice: device === 'System Default' ? '' : device });
	}

	function setInputDevice(device: string) {
		audioInputDevice = device;
		updateSettings({ audioInputDevice: device === 'System Default' ? '' : device });
	}

	onMount(() => {
		void refreshOutputDevices();
		void refreshInputDevices();
	});
</script>

<section class="settings-section">
	<h2>Voice</h2>
	<div class="voice-select">
		<label for="tts-voice">Text-to-speech voice:</label>
		<select
			id="tts-voice"
			value={ttsVoice}
			onchange={(e) => setTtsVoice((e.target as HTMLSelectElement).value)}
		>
			{#each voiceOptions as voice (voice.id)}
				<option value={voice.id}>{voice.name}</option>
			{/each}
		</select>
	</div>
	<label class="toggle-row">
		<input type="checkbox" checked={ttsReadTablesByColumn} onchange={toggleTableReading} />
		<div>
			<strong>Read tables by subject</strong>
			<span>Read all data for each column subject, instead of row by row</span>
		</div>
	</label>
	<p class="hint">Click the speaker icon on any assistant message to hear it read aloud.</p>
</section>

<section class="settings-section">
	<h2>Audio Devices</h2>
	<div class="device-select">
		<label for="output-device">Audio output (TTS playback):</label>
		<div class="device-row">
			<select
				id="output-device"
				value={audioOutputDevice}
				onchange={(e) => setOutputDevice((e.target as HTMLSelectElement).value)}
			>
				{#each outputDevices as device (device)}
					<option value={device}>{device}</option>
				{/each}
			</select>
			<button class="btn btn-small" onclick={refreshOutputDevices}>Refresh</button>
		</div>
	</div>
	<div class="device-select">
		<label for="input-device">Audio input (microphone):</label>
		<div class="device-row">
			<select
				id="input-device"
				value={audioInputDevice}
				onchange={(e) => setInputDevice((e.target as HTMLSelectElement).value)}
			>
				{#each inputDevices as device (device)}
					<option value={device}>{device}</option>
				{/each}
			</select>
			<button class="btn btn-small" onclick={refreshInputDevices}>Refresh</button>
		</div>
	</div>
	<p class="hint">Select audio devices or use "System Default" to follow OS settings.</p>
</section>

<style>
	.hint {
		margin: 8px 0 0 0;
	}

	.voice-select {
		margin-bottom: 8px;
	}

	.voice-select label,
	.device-select label {
		display: block;
		font-size: 0.85rem;
		font-weight: 500;
		margin-bottom: 6px;
	}

	.voice-select select {
		width: 100%;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.voice-select select option,
	.device-row select option {
		background-color: var(--bg-primary);
		color: var(--text-primary);
	}

	.device-select {
		margin-bottom: 12px;
	}

	.device-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}

	.device-row select {
		flex: 1;
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	/* Global .toggle-row supplies the base style; sections add row padding. */
	.toggle-row {
		padding: 8px 0;
	}
</style>
