<script lang="ts">
	/**
	 * Settings → Audio → Speech engine: what `generate_speech` and a video
	 * sequence's narration speak with. Kokoro (bundled) or a llama.cpp
	 * server's `/tts` (directly or through llama-toolchest), which can speak in
	 * a saved voice. Reading answers aloud stays on Kokoro either way.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, updateSettings, type GenerationServer } from '#lib/stores/settings.ts';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import { rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import { inferenceToolchest } from '#lib/toolchest/detect.ts';
	import { toolchestKeyFor } from '#lib/toolchest/models.ts';
	import { withSavedModel } from '#lib/toolchest/kind.ts';
	import type { SpeechEngine } from '#lib/audio/speak.ts';

	let kind = $state<SpeechEngine>(getSettings().speechBackendKind);
	let baseUrl = $state(getSettings().speechServerBaseUrl);
	let apiKeyId = $state<string | null>(getSettings().speechServerApiKeyId);
	let modelId = $state(getSettings().speechServerModelId);

	let probing = $state(false);
	let detail = $state<{ ok: boolean; text: string } | null>(null);
	let models = $state<string[]>([]);
	const options = $derived(
		withSavedModel(
			modelId,
			models.map((m) => ({ name: m, label: m }))
		)
	);

	function chooseKind(e: Event) {
		kind = (e.currentTarget as HTMLSelectElement).value as SpeechEngine;
		updateSettings({ speechBackendKind: kind });
		const found = kind === 'llama-server' && !baseUrl.trim() ? inferenceToolchest() : null;
		if (found) {
			baseUrl = found.baseUrl;
			apiKeyId = found.apiKeyId;
			updateSettings({ speechServerBaseUrl: baseUrl, speechServerApiKeyId: apiKeyId });
		}
		if (kind === 'llama-server' && baseUrl.trim()) void probe();
	}

	async function probe() {
		probing = true;
		detail = null;
		try {
			models = await invoke<string[]>('speech_server_models', {
				baseUrl: baseUrl.trim(),
				apiKey: (await toolchestKeyFor(apiKeyId)) || null
			});
			rememberServer('llama-server', baseUrl, apiKeyId);
			if (!modelId && models.length === 1) {
				modelId = models[0];
				updateSettings({ speechServerModelId: modelId });
			}
			detail = !models.length
				? { ok: false, text: 'The server has no speech models.' }
				: models.includes(modelId)
					? { ok: true, text: `Connected — ${modelId}.` }
					: { ok: false, text: 'Choose a model.' };
		} catch (e) {
			detail = { ok: false, text: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function saveUrl() {
		const next = baseUrl.trim();
		const changed = next !== getSettings().speechServerBaseUrl;
		updateSettings({ speechServerBaseUrl: next });
		if (changed && next) void probe();
	}

	function pickServer(saved: GenerationServer | null) {
		baseUrl = saved?.url ?? '';
		apiKeyId = saved?.keyId ?? apiKeyId;
		updateSettings({ speechServerBaseUrl: baseUrl, speechServerApiKeyId: apiKeyId });
		if (baseUrl) void probe();
	}

	function chooseKey(id: string | null) {
		apiKeyId = id;
		updateSettings({ speechServerApiKeyId: id });
		if (baseUrl.trim()) void probe();
	}

	function chooseModel(e: Event) {
		modelId = (e.currentTarget as HTMLSelectElement).value;
		updateSettings({ speechServerModelId: modelId });
		void probe();
	}

	let probedOnOpen = false;
	$effect(() => {
		if (!probedOnOpen && kind === 'llama-server' && baseUrl.trim()) {
			probedOnOpen = true;
			void probe();
		}
	});
</script>

<section class="settings-section">
	<h2>Speech engine</h2>
	<div class="fields">
		<label for="speech-engine">Engine:</label>
		<select id="speech-engine" value={kind} onchange={chooseKind}>
			<option value="kokoro">Kokoro (on this computer)</option>
			<option value="llama-server">llama.cpp server</option>
		</select>
		{#if kind === 'llama-server'}
			<ServerAddress
				kind="llama-server"
				id="speech-url"
				placeholder="http://host:3000"
				title="A llama-server v0.8.0 or newer that serves /tts, or llama-toolchest."
				keyId={apiKeyId}
				bind:value={baseUrl}
				onCommit={saveUrl}
				onPick={pickServer}
			/>
			<label for="speech-key">API key:</label>
			<div id="speech-key" title="Keys are kept in Settings → Inference → API Keys.">
				<ApiKeyPicker selectedId={apiKeyId} onSelect={chooseKey} />
			</div>
			<label for="speech-model">Model:</label>
			<select
				id="speech-model"
				value={modelId}
				onchange={chooseModel}
				disabled={options.length === 0}
			>
				{#if options.length === 0}
					<option value="">Probe to list the server's speech models</option>
				{:else if !modelId}
					<option value="" disabled>Choose a model</option>
				{/if}
				{#each options as m (m.name)}
					<option value={m.name}>{m.label}</option>
				{/each}
			</select>
		{/if}
	</div>
	{#if kind === 'llama-server'}
		<div class="actions">
			<button onclick={probe} disabled={probing || !baseUrl.trim()}>
				{probing ? 'Probing…' : 'Probe'}
			</button>
			{#if detail}
				<span class="detail" class:bad={!detail.ok}>{detail.text}</span>
			{/if}
		</div>
	{/if}
	<p
		class="help"
		title="Reading answers aloud always uses Kokoro. Qwen3-TTS Base copies a saved voice; llama-toolchest's Get speech models card downloads it."
	>
		Used to make speech audio files and video narration.
	</p>
</section>

<style>
	.fields {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
		margin-top: 8px;
	}

	.fields select {
		width: 100%;
		min-width: 0;
	}

	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		flex-wrap: wrap;
		margin-top: 6px;
	}

	.detail {
		font-size: 0.85em;
		color: var(--text-muted, #888);
	}

	.detail.bad {
		color: var(--error, #c33);
	}
</style>
