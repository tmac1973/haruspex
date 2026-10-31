<script lang="ts">
	import { randomSeed } from '#lib/utils/random.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { loggedFallback } from '#lib/debugLog.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import { rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import type { GenerationServer } from '#lib/stores/settings.ts';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import AudioPlayer from '#lib/components/AudioPlayer.svelte';
	import { resolveMusicBackend } from '#lib/music/index.ts';
	import { seenMusicInstances } from '#lib/music/toolchest/backend.ts';
	import { describeMusicProgress } from '#lib/music/progress.ts';
	import type { MusicBackendKind, MusicProgress } from '#lib/music/types.ts';
	import type { ModelOption, ProbeResult } from '#lib/music/backend.ts';
	import { toolchestHint } from '#lib/toolchest/detect.ts';
	import { prefillFromInference, withSavedModel } from '#lib/toolchest/kind.ts';
	import type { ToolchestInstance } from '#lib/toolchest/models.ts';

	/** The shortest and longest song a request may ask for, in seconds. */
	const MIN_SEC = 5;
	const MAX_SEC = 240;

	let kind = $state<MusicBackendKind>(getSettings().musicBackendKind);
	let baseUrl = $state(getSettings().musicToolchestBaseUrl);
	let apiKeyId = $state<string | null>(getSettings().musicToolchestApiKeyId);
	let modelId = $state(getSettings().musicToolchestModelId);
	let aceUrl = $state(getSettings().musicAceBaseUrl);
	let aceModel = $state(getSettings().musicAceModel);
	let defaultSec = $state(getSettings().musicDefaultDurationSec);

	const isToolchest = $derived(kind === 'llama-toolchest');
	const isAce = $derived(kind === 'ace-server');
	/** The address the chosen backend is set to, if it has one. */
	const configuredUrl = $derived((isAce ? aceUrl : isToolchest ? baseUrl : '').trim());

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	let serverModels = $state<ModelOption[]>([]);
	let instances = $state<ToolchestInstance[]>([]);
	const modelOptions = $derived(withSavedModel(modelId, serverModels));

	/** "llama-toolchest on host has music models", while music is off. */
	let hint = $state<{ host: string; count: number } | null>(null);
	void toolchestHint('music').then((h) => (hint = h));

	let cacheBytes = $state<number | null>(null);
	async function refreshCache() {
		cacheBytes = await invoke<number>('audio_cache_size').catch(
			loggedFallback(null, 'settings', 'could not read the audio cache size')
		);
	}
	void refreshCache();

	function persistKind(e: Event) {
		kind = (e.currentTarget as HTMLSelectElement).value as MusicBackendKind;
		updateSettings({ musicBackendKind: kind });
		const found = kind === 'llama-toolchest' ? prefillFromInference('music') : null;
		if (found) {
			baseUrl = found.baseUrl;
			apiKeyId = found.apiKeyId;
		}
		probeResult = null;
		serverModels = [];
		if (configuredUrl) void probe();
	}

	async function probe() {
		probing = true;
		probeResult = null;
		try {
			probeResult = await resolveMusicBackend().probe();
			if (probeResult.models) serverModels = probeResult.models;
			instances = seenMusicInstances();
			// It answered, so it is worth keeping in the saved list.
			if (configuredUrl && (probeResult.ok || probeResult.models?.length)) {
				if (isAce) rememberServer('ace-server', aceUrl);
				else if (isToolchest) rememberServer('llama-toolchest', baseUrl, apiKeyId);
			}
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function pickServer(saved: GenerationServer | null) {
		baseUrl = saved?.url ?? '';
		apiKeyId = saved?.keyId ?? apiKeyId;
		updateSettings({ musicToolchestBaseUrl: baseUrl, musicToolchestApiKeyId: apiKeyId });
		probeResult = null;
		if (baseUrl) void probe();
	}

	function pickAceServer(saved: GenerationServer | null) {
		aceUrl = saved?.url ?? '';
		updateSettings({ musicAceBaseUrl: aceUrl });
		probeResult = null;
		if (aceUrl) void probe();
	}

	function saveUrl() {
		const next = baseUrl.trim();
		const changed = next !== getSettings().musicToolchestBaseUrl;
		updateSettings({ musicToolchestBaseUrl: next });
		if (changed && next) void probe();
	}

	function chooseKey(id: string | null) {
		apiKeyId = id;
		updateSettings({ musicToolchestApiKeyId: id });
		if (baseUrl.trim()) void probe();
	}

	function chooseModel(e: Event) {
		modelId = (e.currentTarget as HTMLSelectElement).value;
		updateSettings({ musicToolchestModelId: modelId });
		void probe();
	}

	function saveAceUrl() {
		const next = aceUrl.trim();
		const changed = next !== getSettings().musicAceBaseUrl;
		updateSettings({ musicAceBaseUrl: next });
		if (changed && next) void probe();
	}

	function chooseAceModel(e: Event) {
		aceModel = (e.currentTarget as HTMLSelectElement).value;
		updateSettings({ musicAceModel: aceModel });
		void probe();
	}

	function saveDefault() {
		const n = Math.round(Number(defaultSec));
		defaultSec = Number.isFinite(n) ? Math.min(MAX_SEC, Math.max(MIN_SEC, n)) : 30;
		updateSettings({ musicDefaultDurationSec: defaultSec });
	}

	// Probe once on opening, so the model list is there without a click.
	let probedOnOpen = false;
	$effect(() => {
		if (!probedOnOpen && configuredUrl) {
			probedOnOpen = true;
			void probe();
		}
	});

	let generating = $state(false);
	let testError = $state('');
	let testSrc = $state('');
	let testProgress = $state('');
	let controller: AbortController | null = null;

	async function testGeneration() {
		if (generating) {
			controller?.abort();
			return;
		}
		generating = true;
		testError = '';
		testSrc = '';
		controller = new AbortController();
		const started = Date.now();
		let latest: MusicProgress | null = { phase: 'queued' };
		const show = () =>
			(testProgress = describeMusicProgress(latest, Math.round((Date.now() - started) / 1000)));
		show();
		const tick = setInterval(show, 1000);
		try {
			// Not linked to a chat: the cache keeps it for an hour, then lets it go.
			const result = await resolveMusicBackend().generate(
				{
					title: 'Test clip',
					caption: 'short upbeat chiptune loop',
					instrumental: true,
					durationSec: 10,
					seed: randomSeed(),
					format: 'mp3'
				},
				{
					signal: controller.signal,
					onProgress: (p) => {
						latest = p;
						show();
					}
				}
			);
			testSrc = result.url;
		} catch (e) {
			testError = errMessage(e);
		} finally {
			clearInterval(tick);
			generating = false;
			testProgress = '';
			controller = null;
			void refreshCache();
		}
	}

	async function clearCache() {
		try {
			await invoke('audio_cache_clear');
		} catch (e) {
			testError = errMessage(e);
		}
		await refreshCache();
	}

	const cacheLabel = $derived(
		cacheBytes === null
			? ''
			: cacheBytes < 1024 * 1024
				? `${Math.round(cacheBytes / 1024)} KB`
				: `${Math.round(cacheBytes / (1024 * 1024))} MB`
	);
</script>

<section class="settings-section">
	<h2>Music backend</h2>
	<div class="fields">
		<label for="music-backend">Backend:</label>
		<select id="music-backend" value={kind} onchange={persistKind}>
			<option value="none">None</option>
			<option value="llama-toolchest">llama-toolchest</option>
			<option value="ace-server">ace-server</option>
		</select>
	</div>
	<p class="help">Off until you pick one.</p>
	{#if hint && kind === 'none'}
		<p class="help">llama-toolchest on {hint.host} has music models.</p>
	{/if}
</section>

{#if isToolchest}
	<section class="settings-section">
		<h2>Connection</h2>
		<div class="fields">
			<ServerAddress
				kind="llama-toolchest"
				id="music-url"
				placeholder="http://host:3000"
				keyId={apiKeyId}
				bind:value={baseUrl}
				onCommit={saveUrl}
				onPick={pickServer}
			/>

			<label for="music-key">API key:</label>
			<div id="music-key" title="Keys are kept in Settings → Inference → API Keys.">
				<ApiKeyPicker selectedId={apiKeyId} onSelect={chooseKey} />
			</div>

			<label for="music-model">
				Model:
				<Tooltip
					label="About the model"
					text="The server's ACE-Step instances, listed by Probe. A stopped one starts when it is first used."
				/>
			</label>
			<select
				id="music-model"
				value={modelId}
				onchange={chooseModel}
				disabled={modelOptions.length === 0}
			>
				{#if modelOptions.length === 0}
					<option value="">Probe to list the server's models</option>
				{:else if !modelId}
					<option value="" disabled>Choose a model</option>
				{/if}
				{#each modelOptions as m (m.name)}
					<option value={m.name}>{m.label}</option>
				{/each}
			</select>
		</div>
		<div class="actions">
			<button onclick={probe} disabled={probing}>{probing ? 'Probing…' : 'Probe'}</button>
			{#if probeResult}
				<span class="detail" class:bad={!probeResult.ok}>{probeResult.detail}</span>
			{/if}
		</div>
	</section>

	{#if probeResult?.models}
		<ToolchestModels kind="music" {instances} baseUrl={baseUrl.trim()} />
	{/if}
{:else if isAce}
	<section class="settings-section">
		<h2>Connection</h2>
		<div class="fields">
			<ServerAddress
				kind="ace-server"
				id="music-ace-url"
				placeholder="http://host:8083"
				title="acestep.cpp's ace-server, not a llama-toolchest in front of it."
				bind:value={aceUrl}
				onCommit={saveAceUrl}
				onPick={pickAceServer}
			/>

			<label for="music-ace-model">
				Model:
				<Tooltip
					label="About the model"
					text="The synthesis models ace-server loaded, listed by Probe. Server default uses its first."
				/>
			</label>
			<select id="music-ace-model" value={aceModel} onchange={chooseAceModel}>
				<option value="">Server default</option>
				{#if aceModel && !serverModels.some((m) => m.name === aceModel)}
					<option value={aceModel}>
						{aceModel} — {serverModels.length > 0 ? 'not on the server' : 'probe to check'}
					</option>
				{/if}
				{#each serverModels as m (m.name)}
					<option value={m.name}>{m.label}</option>
				{/each}
			</select>
		</div>
		<div class="actions">
			<button onclick={probe} disabled={probing}>{probing ? 'Probing…' : 'Probe'}</button>
			{#if probeResult}
				<span class="detail" class:bad={!probeResult.ok}>{probeResult.detail}</span>
			{/if}
		</div>
	</section>
{/if}

{#if isToolchest || isAce}
	<section class="settings-section">
		<h2>Songs</h2>
		<div class="fields">
			<label for="music-length">Default length:</label>
			<input
				id="music-length"
				type="number"
				min={MIN_SEC}
				max={MAX_SEC}
				bind:value={defaultSec}
				onblur={saveDefault}
				title="Seconds, when a request names no length. 5 to 240."
			/>
		</div>
		<div class="actions">
			<button onclick={testGeneration}>{generating ? 'Stop' : 'Make a test clip'}</button>
			{#if testProgress}<span class="detail">{testProgress}</span>{/if}
			{#if testError}<span class="detail bad">{testError}</span>{/if}
		</div>
		{#if testSrc}
			<AudioPlayer src={testSrc} title="Test clip" />
		{/if}
	</section>
{/if}

<section class="settings-section">
	<h2>Audio cache</h2>
	<div class="actions">
		<span class="detail">{cacheLabel ? `Songs kept: ${cacheLabel}` : ''}</span>
		<button
			onclick={clearCache}
			title="Songs a chat or Code session plays stay until it is deleted."
		>
			Clear unused audio
		</button>
	</div>
</section>

<style>
	/* Label, then its control, one per line, as in Settings → Image. */
	.fields {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
		margin-top: 8px;
	}

	.fields input,
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
