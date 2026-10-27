<script lang="ts">
	import ReportIssueButton from '#lib/components/ReportIssueButton.svelte';
	import { loggedFallback } from '#lib/debug-log.ts';
	import { imageEngineLog } from '#lib/reportLogs.ts';
	import { imageSrc } from '#lib/images/url.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { formatGigabytes } from '#lib/utils/format.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { comfyApiKey, lemonadeApiKey } from '#lib/stores/imageSecrets.ts';
	import type { SettingSecret } from '#lib/stores/settingSecrets.ts';
	import type { AppSettings } from '#lib/stores/settings.ts';
	import {
		savedSecretPlaceholder,
		secretStoreHint,
		secretStoreKind,
		type SecretStoreKind
	} from '#lib/stores/secrets.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ComfyModels from '#lib/components/settings/ComfyModels.svelte';
	import LemonadeModels from '#lib/components/settings/LemonadeModels.svelte';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import { seenInstances } from '#lib/image/toolchest/backend.ts';
	import { inferenceToolchest, toolchestHint } from '#lib/toolchest/detect.ts';
	import type { ApiKeyIdField, ToolchestInstance } from '#lib/toolchest/models.ts';
	import DownloadProgressBar from '#lib/components/settings/DownloadProgressBar.svelte';
	import {
		cancelDownload,
		getActiveDownload,
		runDownload,
		syncDownloads
	} from '#lib/stores/downloads.svelte.ts';
	import { resolveImageBackend } from '#lib/image/index.ts';
	import { capabilityLine, type CapabilityLine } from '#lib/image/capabilityLine.ts';
	import { invalidateTypeAvailability } from '#lib/agent/jobs/types/availability.svelte.ts';
	import { generateOneImage } from '#lib/image/generateOne.ts';
	import { describeImageProgress } from '#lib/image/progress.ts';
	import type {
		ImageBackendCapabilities,
		ImageBackendKind,
		ImageProgress
	} from '#lib/image/types.ts';
	import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
	import type { ImageModelInfo } from '#lib/ipc/gen/ImageModelInfo.ts';
	import type { UpscalerInfo } from '#lib/ipc/gen/UpscalerInfo.ts';

	let imageBackendKind = $state(getSettings().imageBackendKind);

	/**
	 * The backends that are a server the user runs. They share one Connection
	 * section — address, key, Probe, the Model dropdown it fills, and an install
	 * list — each over its own settings, so switching between them loses
	 * neither.
	 */
	interface ServerFields {
		url: 'imageBackendBaseUrl' | 'imageLemonadeBaseUrl' | 'imageToolchestBaseUrl';
		model: 'imageComfyCheckpoint' | 'imageLemonadeModelId' | 'imageToolchestModelId';
		/** Its own secret, or a named key from Settings → Inference → API Keys. */
		key: SettingSecret | { picker: ApiKeyIdField };
		placeholder: string;
		modelTip: string;
	}
	const SERVERS: Partial<Record<ImageBackendKind, ServerFields>> = {
		comfyui: {
			url: 'imageBackendBaseUrl',
			model: 'imageComfyCheckpoint',
			key: comfyApiKey,
			placeholder: 'http://127.0.0.1:8188',
			modelTip:
				'Models the server can run, listed by Probe. A Ming-Image or Qwen-Image-2.1 file in models/diffusion_models brings its own text encoder and VAE, which are found by name; anything in models/checkpoints is run as an SD checkpoint.'
		},
		lemonade: {
			url: 'imageLemonadeBaseUrl',
			model: 'imageLemonadeModelId',
			key: lemonadeApiKey,
			placeholder: 'http://127.0.0.1:13305',
			modelTip:
				"Models installed on the server, listed by Probe: the bundled engine's Ming-Image and Qwen-Image Turbo, run by Lemonade's stable-diffusion.cpp. Lemonade keeps one image model loaded, so the first picture after a switch waits for it to load. It cannot make tiling textures."
		},
		'llama-toolchest': {
			url: 'imageToolchestBaseUrl',
			model: 'imageToolchestModelId',
			key: { picker: 'imageToolchestApiKeyId' },
			placeholder: 'http://host:3000',
			modelTip:
				"The server's image instances, listed by Probe. One must be running to draw; start it in llama-toolchest. It cannot make tiling textures."
		}
	};
	const server = $derived(SERVERS[imageBackendKind] ?? null);

	const initial = SERVERS[getSettings().imageBackendKind];
	let serverUrl = $state(initial ? getSettings()[initial.url] : '');
	let serverModel = $state(initial ? getSettings()[initial.model] : '');
	/** A key being typed. Stored when the field loses focus, then cleared. */
	let apiKeyDraft = $state('');
	let apiKeySaved = $state(
		initial && 'configured' in initial.key ? initial.key.configured() : false
	);
	/** The named key, for a server that uses one. */
	let apiKeyId = $state<string | null>(
		initial && 'picker' in initial.key ? getSettings()[initial.key.picker] : null
	);
	/** The toolchest's instances from the last probe, for its table. */
	let toolchestInstances = $state<ToolchestInstance[]>([]);
	/** "llama-toolchest on host has image models", while the backend is off. */
	let hint = $state<{ host: string; count: number } | null>(null);
	void toolchestHint('image').then((h) => (hint = h));

	function chooseKey(id: string | null) {
		if (!server || !('picker' in server.key)) return;
		apiKeyId = id;
		persist({ [server.key.picker]: id } as Partial<AppSettings>);
		if (serverUrl.trim()) void probe();
	}
	let storeKind = $state<SecretStoreKind>('keychain');
	void secretStoreKind().then((k) => (storeKind = k));

	async function saveApiKey() {
		const value = apiKeyDraft.trim();
		if (!value || !server || !('save' in server.key)) return;
		try {
			await server.key.save(value);
			apiKeyDraft = '';
			apiKeySaved = true;
		} catch (e) {
			probeResult = { ok: false, detail: `Could not save the key: ${errMessage(e)}` };
		}
	}

	async function removeApiKey() {
		if (server && 'remove' in server.key) await server.key.remove();
		apiKeySaved = false;
	}
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

	let upscaler = $state<UpscalerInfo | null>(null);
	const UPSCALER_KEY = 'image:upscaler';

	/** What the bundled engine can do with the chosen model, for its line. */
	let localCapabilities = $state<ImageBackendCapabilities | null>(null);

	async function refreshLocalCapabilities() {
		localCapabilities =
			getSettings().imageBackendKind === 'local' && imageLocalModelId
				? await resolveImageBackend()
						.capabilities()
						.catch(() => null)
				: null;
	}

	async function refreshModels() {
		models = await invoke<ImageModel[]>('image_models').catch(
			loggedFallback([], 'settings', 'could not list the image models')
		);
		void refreshLocalCapabilities();
		upscaler = await invoke<UpscalerInfo>('image_upscaler').catch(
			loggedFallback(null, 'settings', 'could not read the upscaler')
		);
	}

	async function downloadUpscaler() {
		downloadError = '';
		try {
			await runDownload(UPSCALER_KEY, () =>
				invoke('image_upscaler_download', { proxy: getSettings().proxy })
			);
		} catch (e) {
			downloadError = errMessage(e);
		} finally {
			await refreshModels();
		}
	}

	async function deleteUpscaler() {
		downloadError = '';
		await invoke('image_upscaler_delete').catch((e: unknown) => {
			downloadError = errMessage(e);
		});
		await refreshModels();
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

	/** Size of the optional files not yet on disk (Qwen's vision weights). */
	const editingBytes = (m: ImageModel) =>
		m.files.filter((f) => f.optional).reduce((n, f) => n + f.size_bytes, 0);

	/** The optional vision weights for a model already downloaded, so it can edit. */
	async function addEditing(m: ImageModel) {
		downloadError = '';
		try {
			await runDownload(keyOf(m), () =>
				invoke('download_image_model', { id: m.id, proxy: getSettings().proxy })
			);
		} catch (e) {
			downloadError = errMessage(e);
		} finally {
			await refreshModels();
		}
	}

	async function selectModel(m: ImageModel) {
		imageLocalModelId = m.id;
		persist({ imageLocalModelId: m.id });
		void refreshLocalCapabilities();
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
		const current = serverModel.trim();
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
	const isComfy = $derived(imageBackendKind === 'comfyui');
	const isToolchest = $derived(imageBackendKind === 'llama-toolchest');

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
		// A toolchest with nothing set yet starts from the inference server,
		// when that is a toolchest: usually the same machine and key.
		const found = imageBackendKind === 'llama-toolchest' ? inferenceToolchest() : null;
		if (found && !getSettings().imageToolchestBaseUrl.trim()) {
			updateSettings({
				imageToolchestBaseUrl: found.baseUrl,
				imageToolchestApiKeyId: found.apiKeyId
			});
		}
		// Another server's fields: its own address, key, model and list.
		const s = getSettings();
		serverUrl = server ? s[server.url] : '';
		serverModel = server ? s[server.model] : '';
		apiKeySaved = server && 'configured' in server.key ? server.key.configured() : false;
		apiKeyId = server && 'picker' in server.key ? s[server.key.picker] : null;
		toolchestInstances = [];
		apiKeyDraft = '';
		serverModels = [];
		probeCount = 0;
		probedOnOpen = false;
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
			if (isToolchest) toolchestInstances = seenInstances();
			capabilities = probeResult.ok ? await backend.capabilities() : null;
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function chooseModel(e: Event) {
		if (!server) return;
		serverModel = (e.currentTarget as HTMLSelectElement).value;
		persist({ [server.model]: serverModel } as Partial<AppSettings>);
		// Re-checked at once: a DiT model also needs its text encoder and VAE
		// on the server, and that is the probe's job to say.
		void probe();
	}

	function saveUrl() {
		if (!server) return;
		const next = serverUrl.trim();
		const changed = next !== getSettings()[server.url];
		persist({ [server.url]: next } as Partial<AppSettings>);
		if (changed && next) void probe();
	}

	// Probe once on opening, so the model list is there without a click.
	let probedOnOpen = false;
	$effect(() => {
		if (server && !probedOnOpen && serverUrl.trim()) {
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
		controller = new AbortController();
		const started = Date.now();
		let latest: ImageProgress | null = { phase: 'queued' };
		const show = () =>
			(testProgress = describeImageProgress(latest, Math.round((Date.now() - started) / 1000)));
		show();
		const tick = setInterval(show, 1000);
		try {
			const result = await generateOneImage({
				prompt: 'a red apple on a plain background',
				signal: controller.signal,
				onProgress: (p) => {
					latest = p;
					show();
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
			clearInterval(tick);
			generating = false;
			testProgress = '';
			controller = null;
		}
	}
</script>

{#snippet canLine(line: CapabilityLine)}
	<p class="help" title={line.howTo || undefined}>{line.text}</p>
{/snippet}

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
			<option value="lemonade">Lemonade</option>
			<option value="llama-toolchest">llama-toolchest</option>
		</select>
	</div>
	<p class="help">Off until you pick one; nothing is downloaded or started before that.</p>
	{#if hint && imageBackendKind === 'none'}
		<p class="help">llama-toolchest on {hint.host} has image models.</p>
	{/if}
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
					· {formatGigabytes(m.size_bytes)} in {m.files.filter((f) => !f.optional).length} files
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
						{#if !m.can_edit && editingBytes(m) > 0 && active?.key !== keyOf(m)}
							<button
								onclick={() => addEditing(m)}
								disabled={active !== null}
								title={`Downloads the vision weights it edits pictures with (${formatGigabytes(editingBytes(m))}).`}
							>
								Add editing
							</button>
						{/if}
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
		{#if upscaler}
			<div class="model">
				<div class="model-head">
					<strong>Upscaler — Real-ESRGAN x4plus, for making pictures larger</strong>
				</div>
				<p class="help" title={upscaler.filename}>
					{upscaler.license}
					<a href={upscaler.license_url} target="_blank" rel="noreferrer">Full text</a>
					· {Math.round(upscaler.size_bytes / 1e6)} MB
				</p>
				<div class="row">
					{#if upscaler.downloaded}
						<button onclick={deleteUpscaler}>Delete</button>
					{:else if active?.key !== UPSCALER_KEY}
						<button
							onclick={downloadUpscaler}
							disabled={active !== null}
							title={active ? 'Another download is running.' : undefined}
						>
							Download
						</button>
					{/if}
				</div>
				{#if active?.key === UPSCALER_KEY}
					<DownloadProgressBar progress={active.progress} oncancel={cancelDownload} />
				{/if}
			</div>
		{/if}
		{#if downloadError}
			<p class="warn">{downloadError}</p>
		{/if}

		{#if localCapabilities}
			{@render canLine(capabilityLine(localCapabilities, 'local'))}
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

{#if server}
	<section class="settings-section">
		<h2>Connection</h2>
		<div class="fields">
			<label for="image-url">Server address:</label>
			<input
				id="image-url"
				type="text"
				placeholder={server.placeholder}
				bind:value={serverUrl}
				onblur={saveUrl}
			/>

			<label for="image-key">API key:</label>
			{#if 'picker' in server.key}
				<div id="image-key" title="Keys are kept in Settings → Inference → API Keys.">
					<ApiKeyPicker selectedId={apiKeyId} onSelect={chooseKey} />
				</div>
			{:else}
				<input
					id="image-key"
					type="password"
					placeholder={apiKeySaved
						? savedSecretPlaceholder(storeKind)
						: 'only if the server needs one'}
					title={apiKeySaved ? secretStoreHint(storeKind) : undefined}
					bind:value={apiKeyDraft}
					onblur={saveApiKey}
				/>
				{#if apiKeySaved}
					<button type="button" onclick={removeApiKey}>Remove key</button>
				{/if}
			{/if}

			<label for="image-model">
				Model:
				<Tooltip label="About the model" text={server.modelTip} />
			</label>
			<select
				id="image-model"
				value={serverModel}
				onchange={chooseModel}
				disabled={modelOptions.length === 0}
			>
				{#if modelOptions.length === 0}
					<option value="">Probe to list the server's models</option>
				{:else if !serverModel}
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
			{@render canLine(capabilityLine(capabilities, imageBackendKind))}
		{/if}
	</section>

	{#if probeCount > 0}
		{#if isComfy}
			<ComfyModels {probeCount} onInstalled={() => void probe()} />
		{:else if isToolchest}
			<ToolchestModels kind="image" instances={toolchestInstances} baseUrl={serverUrl.trim()} />
		{:else}
			<LemonadeModels {probeCount} onInstalled={() => void probe()} />
		{/if}
	{/if}
{/if}

{#if configured}
	<section class="settings-section">
		<h2>Test generation</h2>
		<div class="actions">
			<button onclick={testGeneration}>{generating ? 'Stop' : 'Generate a test image'}</button>
			{#if testProgress}<span class="detail">{testProgress}</span>{/if}
			{#if testError}<span class="detail bad">{testError}</span>{/if}
			<!-- Only the bundled engine is ours: another backend's failure is
			     usually its own server's. -->
			{#if testError && isLocal}
				<ReportIssueButton
					where="Bundled image engine"
					error={testError}
					log={imageEngineLog}
					logTitle="Image engine log"
				/>
			{/if}
		</div>
		{#if testHash}
			<img class="preview" src={imageSrc(testHash)} alt="Test generation" />
		{/if}
		<p class="help">Makes one picture through the configured backend. Nothing else is affected.</p>
	</section>
{/if}

{#if isComfy}
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
