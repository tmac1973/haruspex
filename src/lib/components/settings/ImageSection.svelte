<script lang="ts">
	import { imageSrc } from '$lib/images/url';
	import { errMessage } from '$lib/utils/error';
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings, updateSettings } from '$lib/stores/settings';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import ComfyModels from './ComfyModels.svelte';
	import DownloadProgressBar from './DownloadProgressBar.svelte';
	import {
		cancelDownload,
		getActiveDownload,
		runDownload,
		syncDownloads
	} from '$lib/stores/downloads.svelte';
	import { resolveImageBackend } from '$lib/image';
	import { invalidateTypeAvailability } from '$lib/agent/jobs/types/availability.svelte';
	import { generateOneImage } from '$lib/image/generateOne';
	import type { ImageBackendCapabilities, ImageBackendKind } from '$lib/image/types';
	import type { ModelOption, ProbeResult } from '$lib/image/backend';
	import type { ImageModelInfo } from '$lib/ipc/gen/ImageModelInfo';

	let imageBackendKind = $state(getSettings().imageBackendKind);
	let imageBackendBaseUrl = $state(getSettings().imageBackendBaseUrl);
	let imageBackendApiKey = $state(getSettings().imageBackendApiKey);
	let imageComfyCheckpoint = $state(getSettings().imageComfyCheckpoint);
	let imageLocalModelId = $state(getSettings().imageLocalModelId);

	type ImageModel = ImageModelInfo;

	let models = $state<ImageModel[]>([]);
	let downloadError = $state('');
	/** Any download, here or elsewhere: one runs at a time (Rust enforces it). */
	const active = $derived(getActiveDownload());
	const keyOf = (m: ImageModel) => `image:${m.id}`;

	// A download that outlived a closed Settings is shown again on opening, and
	// the list refreshes when whatever was downloading ends.
	$effect(() => {
		void syncDownloads();
	});
	let wasActive = false;
	$effect(() => {
		const now = active !== null;
		if (wasActive && !now) void refreshModels();
		wasActive = now;
	});

	async function refreshModels() {
		models = await invoke<ImageModel[]>('image_models').catch(() => []);
	}

	function gb(bytes: number): string {
		return `${(bytes / 1e9).toFixed(1)} GB`;
	}

	async function downloadModel(m: ImageModel) {
		// Asked before the download, not after: the point of the warning is to
		// stop gigabytes arriving for a licence the user cannot use.
		if (!m.commercial_use) {
			const ok = window.confirm(
				`${m.license}\n\nThis model may not be used commercially. Download it anyway?`
			);
			if (!ok) return;
		}
		downloadError = '';
		try {
			await runDownload(keyOf(m), () =>
				invoke('download_image_model', { id: m.id, proxy: getSettings().proxy })
			);
			await selectModel(m);
		} catch (e) {
			downloadError = errMessage(e);
		} finally {
			await refreshModels();
		}
	}

	async function selectModel(m: ImageModel) {
		imageLocalModelId = m.id;
		persist({ imageLocalModelId: m.id });
		await refreshEngine();
	}

	async function deleteModel(m: ImageModel) {
		// The engine holds the file open while it runs.
		await invoke('image_engine_stop').catch(() => {});
		downloadError = '';
		try {
			await invoke('delete_image_model', { id: m.id });
		} catch (e) {
			downloadError = errMessage(e);
			await refreshModels();
			await refreshEngine();
			return;
		}
		if (imageLocalModelId === m.id) {
			imageLocalModelId = '';
			persist({ imageLocalModelId: '' });
		}
		await refreshModels();
		await refreshEngine();
	}

	$effect(() => {
		if (isLocal) void refreshModels();
	});
	let imageComfyWorkflowPath = $state(getSettings().imageComfyWorkflowPath);
	let imageComfyFieldMapPath = $state(getSettings().imageComfyFieldMapPath);

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	/** Bumped after each probe that reached the server, so the model rows re-check. */
	let probeCount = $state(0);
	let capabilities = $state<ImageBackendCapabilities | null>(null);
	/** What the server can run, from the last probe that could say. */
	let serverModels = $state<ModelOption[]>([]);
	/** The dropdown's options: the server's, plus the saved one if it is not among them. */
	const modelOptions = $derived.by((): ModelOption[] => {
		const current = imageComfyCheckpoint.trim();
		if (!current || serverModels.some((m) => m.name === current)) return serverModels;
		const why = serverModels.length > 0 ? 'not on the server' : 'probe to check';
		return [{ name: current, label: `${current} — ${why}` }, ...serverModels];
	});

	let generating = $state(false);
	let testError = $state('');
	let testHash = $state('');
	let testProgress = $state('');
	let controller: AbortController | null = null;

	const configured = $derived(imageBackendKind !== 'none');
	const isLocal = $derived(imageBackendKind === 'local');

	// The bundled engine, if this platform has one. Asked once: the answer is
	// a property of the install, not of the session.
	let engine = $state<{ status: string; model: string | null; available: boolean } | null>(null);
	let engineLogs = $state<string[]>([]);
	let engineBusy = $state(false);

	async function refreshEngine() {
		try {
			const st = await invoke<{
				status: { type: string; message?: string };
				model: string | null;
				available: boolean;
			}>('image_engine_status');
			engine = {
				status: st.status.type === 'Error' ? (st.status.message ?? 'Error') : st.status.type,
				model: st.model,
				available: st.available
			};
		} catch {
			engine = null;
		}
	}

	async function startEngine() {
		engineBusy = true;
		try {
			await invoke('image_engine_start', { modelId: imageLocalModelId.trim() });
		} catch (e) {
			probeResult = { ok: false, detail: (e as { detail?: string })?.detail ?? String(e) };
		} finally {
			engineBusy = false;
			await refreshEngine();
			engineLogs = await invoke<string[]>('image_engine_logs').catch(() => []);
		}
	}

	async function stopEngine() {
		engineBusy = true;
		try {
			await invoke('image_engine_stop');
		} finally {
			engineBusy = false;
			await refreshEngine();
		}
	}

	$effect(() => {
		if (isLocal) void refreshEngine();
	});

	function persistKind(e: Event) {
		const was = imageBackendKind;
		imageBackendKind = (e.currentTarget as HTMLSelectElement).value as ImageBackendKind;
		// Leaving the bundled engine stops it: nothing else uses it, and it
		// holds ~7 GB of VRAM that ComfyUI or a game would want back.
		if (was === 'local' && imageBackendKind !== 'local') {
			void invoke('image_engine_stop')
				.catch(() => {})
				.then(() => refreshEngine());
		}
		updateSettings({ imageBackendKind });
		probeResult = null;
		capabilities = null;
		// The asset job type is gated on a configured backend, and that gate's
		// answer is cached for the session. Without this, turning a backend on
		// leaves the type missing from the job picker until the app restarts.
		invalidateTypeAvailability();
	}

	const persist = (patch: Parameters<typeof updateSettings>[0]) => updateSettings(patch);

	async function probe() {
		probing = true;
		probeResult = null;
		try {
			const backend = resolveImageBackend();
			probeResult = await backend.probe();
			if (probeResult.models) {
				serverModels = probeResult.models;
				probeCount++;
			}
			capabilities = probeResult.ok ? await backend.capabilities() : null;
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function chooseModel(e: Event) {
		imageComfyCheckpoint = (e.currentTarget as HTMLSelectElement).value;
		persist({ imageComfyCheckpoint });
		// Re-checked at once: a DiT model also needs its text encoder and VAE
		// on the server, and that is the probe's job to say.
		void probe();
	}

	function saveUrl() {
		const next = imageBackendBaseUrl.trim();
		const changed = next !== getSettings().imageBackendBaseUrl;
		persist({ imageBackendBaseUrl: next });
		if (changed && next) void probe();
	}

	// Probe once on opening, so the model list is there without a click.
	let probedOnOpen = false;
	$effect(() => {
		if (configured && !isLocal && !probedOnOpen && imageBackendBaseUrl.trim()) {
			probedOnOpen = true;
			void probe();
		}
	});

	async function testGeneration() {
		if (generating) {
			controller?.abort();
			return;
		}
		generating = true;
		testError = '';
		testHash = '';
		testProgress = 'Queued…';
		controller = new AbortController();
		try {
			const result = await generateOneImage({
				prompt: 'a red apple on a plain background',
				signal: controller.signal,
				onProgress: (p) => {
					testProgress =
						p.step && p.totalSteps ? `Step ${p.step} of ${p.totalSteps}…` : `${p.phase}…`;
				}
			});
			const img = result.images[0];
			testHash = await invoke<string>('image_store_bytes', {
				bytes: Array.from(img.bytes),
				mime: img.mimeType,
				width: img.width,
				height: img.height
			});
		} catch (e) {
			testError = errMessage(e);
		} finally {
			generating = false;
			testProgress = '';
			controller = null;
		}
	}
</script>

<section class="settings-section">
	<h2>Image backend</h2>
	<div class="fields">
		<label for="image-backend">Backend:</label>
		<select id="image-backend" value={imageBackendKind} onchange={persistKind}>
			<option value="none">None</option>
			<option value="comfyui">ComfyUI</option>
			{#if engine?.available !== false}
				<option value="local">Bundled engine</option>
			{/if}
		</select>
	</div>
	<p class="help">Off until you pick one; nothing is downloaded or started before that.</p>
</section>

{#if isLocal}
	<section class="settings-section">
		<h2>Bundled engine</h2>
		{#each models as m (m.id)}
			<div class="model" class:selected={imageLocalModelId === m.id}>
				<div class="model-head">
					<strong>{m.description}</strong>
					{#if imageLocalModelId === m.id}<span class="badge">selected</span>{/if}
				</div>
				<p class="help" title={m.files.map((f) => `${f.role}: ${f.filename}`).join('\n')}>
					{m.license}
					<a href={m.license_url} target="_blank" rel="noreferrer">Full text</a>
					· {gb(m.size_bytes)} in {m.files.length} files
				</p>
				{#if !m.commercial_use}
					<p class="warn">Not licensed for commercial use.</p>
				{/if}
				<div class="row">
					{#if m.downloaded}
						<button onclick={() => selectModel(m)} disabled={imageLocalModelId === m.id}>
							Use
						</button>
						<button onclick={() => deleteModel(m)}>Delete</button>
					{:else if active?.key !== keyOf(m)}
						<button
							onclick={() => downloadModel(m)}
							disabled={active !== null}
							title={active ? 'Another download is running.' : undefined}
						>
							Download
						</button>
					{/if}
				</div>
				{#if active?.key === keyOf(m)}
					<DownloadProgressBar progress={active.progress} oncancel={cancelDownload} />
				{/if}
			</div>
		{/each}
		{#if downloadError}
			<p class="warn">{downloadError}</p>
		{/if}

		<p class="help">Nothing starts until you ask.</p>
		<div class="row">
			<button onclick={startEngine} disabled={engineBusy || engine?.status === 'Ready'}>
				{engineBusy ? 'Working…' : 'Start'}
			</button>
			<button onclick={stopEngine} disabled={engineBusy || engine?.status === 'Stopped'}>
				Stop
			</button>
			<span class="status">{engine?.status ?? 'Unknown'}</span>
		</div>
		{#if engineLogs.length > 0}
			<details>
				<summary>Engine log</summary>
				<pre class="logs">{engineLogs.slice(-40).join('\n')}</pre>
			</details>
		{/if}
	</section>
{/if}

{#if configured && !isLocal}
	<section class="settings-section">
		<h2>Connection</h2>
		<div class="fields">
			<label for="image-url">Server address:</label>
			<input
				id="image-url"
				type="text"
				placeholder="http://127.0.0.1:8188"
				bind:value={imageBackendBaseUrl}
				onblur={saveUrl}
			/>

			<label for="image-key">API key:</label>
			<input
				id="image-key"
				type="password"
				placeholder="only if the server needs one"
				bind:value={imageBackendApiKey}
				onblur={() => persist({ imageBackendApiKey: imageBackendApiKey.trim() })}
			/>

			<label for="image-model">
				Model:
				<Tooltip
					label="About the model"
					text="Models the server can run, listed by Probe. A Ming-Image or Qwen-Image-2.1 file in models/diffusion_models brings its own text encoder and VAE, which are found by name; anything in models/checkpoints is run as an SD checkpoint."
				/>
			</label>
			<select
				id="image-model"
				value={imageComfyCheckpoint}
				onchange={chooseModel}
				disabled={modelOptions.length === 0}
			>
				{#if modelOptions.length === 0}
					<option value="">Probe to list the server's models</option>
				{:else if !imageComfyCheckpoint}
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
		{#if capabilities}
			<p class="help">
				Supports: transparency {capabilities.transparency ? 'yes' : 'no'}, seamless tiling {capabilities.seamlessTiling
					? 'yes'
					: 'no'}, LoRA slots {capabilities.maxLoras}.
			</p>
		{/if}
	</section>

	{#if probeCount > 0}
		<ComfyModels {probeCount} onInstalled={() => void probe()} />
	{/if}
{/if}

{#if configured}
	<section class="settings-section">
		<h2>Test generation</h2>
		<div class="actions">
			<button onclick={testGeneration}>{generating ? 'Stop' : 'Generate a test image'}</button>
			{#if testProgress}<span class="detail">{testProgress}</span>{/if}
			{#if testError}<span class="detail bad">{testError}</span>{/if}
		</div>
		{#if testHash}
			<img class="preview" src={imageSrc(testHash)} alt="Test generation" />
		{/if}
		<p class="help">Makes one picture through the configured backend. Nothing else is affected.</p>
	</section>
{/if}

{#if configured && !isLocal}
	<details class="settings-section">
		<summary><h2>Custom workflow</h2></summary>
		<div class="fields">
			<label for="image-workflow">Workflow:</label>
			<input
				id="image-workflow"
				type="text"
				placeholder="API-format workflow JSON"
				bind:value={imageComfyWorkflowPath}
				onblur={() => persist({ imageComfyWorkflowPath: imageComfyWorkflowPath.trim() })}
			/>

			<label for="image-fieldmap">Field map:</label>
			<input
				id="image-fieldmap"
				type="text"
				placeholder="field map JSON"
				bind:value={imageComfyFieldMapPath}
				onblur={() => persist({ imageComfyFieldMapPath: imageComfyFieldMapPath.trim() })}
			/>
		</div>
		<p class="help" title="Set both or neither — one without the other fails the probe.">
			Replaces the built-in workflows.
		</p>
	</details>
{/if}

<style>
	/* The engine's own log: long lines scroll inside the box, not the page. */
	.logs {
		max-height: 16rem;
		max-width: 100%;
		overflow: auto;
		white-space: pre;
		font-size: 0.75em;
		padding: 8px;
		margin-top: 6px;
		border: 1px solid var(--border, rgba(127, 127, 127, 0.3));
		border-radius: 6px;
		background: var(--code-bg, rgba(127, 127, 127, 0.08));
	}

	/* Label, then its control, one per line. */
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

	.preview {
		display: block;
		margin-top: 10px;
		max-width: 256px;
		border-radius: 6px;
		image-rendering: pixelated;
	}

	summary h2 {
		display: inline;
	}
</style>
