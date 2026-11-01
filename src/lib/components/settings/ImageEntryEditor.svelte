<script lang="ts">
	/**
	 * One image model in Settings → Image, open for editing: its backend, its
	 * server, key and model, Probe, what it can do, and the backend's own
	 * install list or catalogue. Writes go to the entry (`#lib/image/entries.ts`),
	 * never to the old single-backend fields.
	 */
	import ReportIssueButton from '#lib/components/ReportIssueButton.svelte';
	import { loggedFallback } from '#lib/debugLog.ts';
	import { imageEngineLog } from '#lib/reportLogs.ts';
	import { imageSrc } from '#lib/images/url.ts';
	import { errMessage } from '#lib/utils/error.ts';
	import { formatGigabytes } from '#lib/utils/format.ts';
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings } from '#lib/stores/settings.ts';
	import type { GenerationServer, GenerationServerKind } from '#lib/stores/settings.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ComfyModels from '#lib/components/settings/ComfyModels.svelte';
	import LemonadeModels from '#lib/components/settings/LemonadeModels.svelte';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import DownloadProgressBar from '#lib/components/settings/DownloadProgressBar.svelte';
	import { rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import {
		cancelDownload,
		getActiveDownload,
		runDownload,
		syncDownloads
	} from '#lib/stores/downloads.svelte.ts';
	import { seenInstances } from '#lib/image/toolchest/backend.ts';
	import { inferenceToolchest } from '#lib/toolchest/detect.ts';
	import { withSavedModel } from '#lib/toolchest/kind.ts';
	import type { ToolchestInstance } from '#lib/toolchest/models.ts';
	import { useLemonadeServer } from '#lib/image/lemonade/client.ts';
	import { backendForEntry } from '#lib/image/index.ts';
	import {
		IMAGE_BACKEND_LABEL,
		entryApiKey,
		entryById,
		imageEntries,
		renameImageModel,
		saveImageCaps,
		updateImageModel
	} from '#lib/image/entries.ts';
	import { capabilityLine, type CapabilityLine } from '#lib/image/capabilityLine.ts';
	import { declaredCapabilities, familyOfId } from '#lib/image/local/adapter.ts';
	import { invalidateTypeAvailability } from '#lib/agent/jobs/types/availability.svelte.ts';
	import { generateOneImage } from '#lib/image/generateOne.ts';
	import { describeImageProgress } from '#lib/image/progress.ts';
	import type {
		ImageBackendCapabilities,
		ImageModelEntry,
		ImageProgress
	} from '#lib/image/types.ts';
	import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
	import type { ImageModelInfo } from '#lib/ipc/gen/ImageModelInfo.ts';
	import type { UpscalerInfo } from '#lib/ipc/gen/UpscalerInfo.ts';

	type Kind = ImageModelEntry['backend'];

	interface Props {
		/** The entry as it was when opened; the editor writes through to it. */
		entry: ImageModelEntry;
		/** This platform has a bundled engine; null until known. */
		engineAvailable: boolean | null;
		/** Told after each change saved, so the list shows it. */
		onChange: () => void;
	}
	let { entry, engineAvailable, onChange }: Props = $props();

	// Opened once per entry: the parent keys this component by its id.
	// svelte-ignore state_referenced_locally
	const id = entry.id;
	// svelte-ignore state_referenced_locally
	let backend = $state<Kind>(entry.backend);
	// svelte-ignore state_referenced_locally
	let name = $state(entry.name);
	// svelte-ignore state_referenced_locally
	let url = $state(entry.url);
	// svelte-ignore state_referenced_locally
	let keyId = $state<string | null>(entry.keyId);
	// svelte-ignore state_referenced_locally
	let model = $state(entry.model);
	// svelte-ignore state_referenced_locally
	let workflowPath = $state(entry.options.workflowPath ?? '');
	// svelte-ignore state_referenced_locally
	let fieldMapPath = $state(entry.options.fieldMapPath ?? '');

	/** What each server backend's Model dropdown is about, for its tooltip. */
	const SERVER_TIPS: Record<Exclude<Kind, 'local'>, { placeholder: string; modelTip: string }> = {
		comfyui: {
			placeholder: 'http://127.0.0.1:8188',
			modelTip:
				'Models the server can run, listed by Probe. A Ming-Image or Qwen-Image-2.1 file in models/diffusion_models brings its own text encoder and VAE, which are found by name; anything in models/checkpoints is run as an SD checkpoint.'
		},
		lemonade: {
			placeholder: 'http://127.0.0.1:13305',
			modelTip:
				"Models installed on the server, listed by Probe: the bundled engine's Ming-Image and Qwen-Image Turbo, run by Lemonade's stable-diffusion.cpp. Lemonade keeps one image model loaded, so the first picture after a switch waits for it to load. It cannot make tiling textures."
		},
		'llama-toolchest': {
			placeholder: 'http://host:3000',
			modelTip:
				"The server's image instances, listed by Probe. A stopped one starts when it is first used. It cannot make tiling textures."
		}
	};

	const isLocal = $derived(backend === 'local');
	const isComfy = $derived(backend === 'comfyui');
	const isToolchest = $derived(backend === 'llama-toolchest');
	const serverKind = $derived<GenerationServerKind | null>(backend === 'local' ? null : backend);
	const server = $derived(backend === 'local' ? null : SERVER_TIPS[backend]);

	/** The entry as saved now, for building its backend. */
	const current = () => entryById(id) ?? entry;
	/** Write to the entry; returns it as saved. */
	function patch(p: Partial<Omit<ImageModelEntry, 'id'>>) {
		updateImageModel(id, p);
		name = current().name;
		onChange();
	}

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	/** Bumped after each probe that reached the server, so the install rows re-check. */
	let probeCount = $state(0);
	let capabilities = $state<ImageBackendCapabilities | null>(null);
	let serverModels = $state<ModelOption[]>([]);
	const modelOptions = $derived(withSavedModel(model, serverModels));
	let toolchestInstances = $state<ToolchestInstance[]>([]);
	/** The key the install panels send, resolved from the named one. */
	let apiKey = $state('');

	async function probe() {
		probing = true;
		probeResult = null;
		try {
			const saved = current();
			const b = backendForEntry(saved);
			if (!b) throw new Error(`${IMAGE_BACKEND_LABEL[saved.backend]} isn't in this build.`);
			apiKey = await entryApiKey(saved);
			if (saved.backend === 'lemonade') useLemonadeServer({ baseUrl: saved.url, apiKey });
			probeResult = await b.probe();
			if (probeResult.models) {
				serverModels = probeResult.models;
				probeCount++;
			}
			if (saved.backend === 'llama-toolchest') toolchestInstances = seenInstances(saved);
			// It answered, so it is worth keeping in the saved list.
			if (serverKind && (probeResult.ok || probeResult.models?.length)) {
				rememberServer(serverKind, url, keyId);
			}
			const caps = probeResult.ok ? await b.capabilities() : null;
			// Kept with the entry, so the tools know without asking the server.
			if (caps) {
				saveImageCaps(id, caps);
				onChange();
			}
			capabilities = caps;
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function chooseBackend(e: Event) {
		const was = backend;
		backend = (e.currentTarget as HTMLSelectElement).value as Kind;
		// Leaving the bundled engine stops it, unless another model still uses it:
		// it holds ~7 GB of VRAM that ComfyUI or a game would want back.
		if (was === 'local' && !imageEntries().some((o) => o.id !== id && o.backend === 'local')) {
			void invoke('image_engine_stop')
				.catch(() => {})
				.then(() => refreshEngine());
		}
		url = '';
		model = '';
		workflowPath = '';
		fieldMapPath = '';
		const found = backend === 'llama-toolchest' ? inferenceToolchest() : null;
		if (found) {
			url = found.baseUrl;
			keyId = found.apiKeyId;
		}
		patch({ backend, url, keyId, model, options: {} });
		probeResult = null;
		capabilities = null;
		serverModels = [];
		toolchestInstances = [];
		probeCount = 0;
		probedOnOpen = false;
		// The asset job type is gated on a usable model, and that gate's answer
		// is cached for the session.
		invalidateTypeAvailability();
	}

	function chooseKey(next: string | null) {
		keyId = next;
		patch({ keyId });
		if (url.trim()) void probe();
	}

	function chooseModel(e: Event) {
		model = (e.currentTarget as HTMLSelectElement).value;
		patch({ model });
		// Re-checked at once: a DiT model also needs its text encoder and VAE
		// on the server, and that is the probe's job to say.
		void probe();
	}

	function pickServer(saved: GenerationServer | null) {
		url = saved?.url ?? '';
		if (saved) keyId = saved.keyId;
		patch({ url, keyId });
		probeResult = null;
		if (url) void probe();
	}

	function saveUrl() {
		const next = url.trim();
		const changed = next !== current().url;
		patch({ url: next });
		if (changed && next) void probe();
	}

	function saveName() {
		renameImageModel(id, name);
		name = current().name;
		onChange();
	}

	function saveWorkflow() {
		patch({ options: { workflowPath: workflowPath.trim(), fieldMapPath: fieldMapPath.trim() } });
	}

	// Probe once on opening, so the model list is there without a click.
	let probedOnOpen = false;
	$effect(() => {
		if (server && !probedOnOpen && url.trim()) {
			probedOnOpen = true;
			void probe();
		}
	});

	// --- The bundled engine ---------------------------------------------------

	let models = $state<ImageModelInfo[]>([]);
	let downloadError = $state('');
	/** Any download, here or elsewhere: one runs at a time (Rust enforces it). */
	const active = $derived(getActiveDownload());
	const keyOf = (m: ImageModelInfo) => `image:${m.id}`;
	let upscaler = $state<UpscalerInfo | null>(null);
	const UPSCALER_KEY = 'image:upscaler';

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

	/** What the bundled engine could do with this model, whether or not it is the chosen one. */
	function localLine(m: ImageModelInfo): CapabilityLine {
		return capabilityLine(
			declaredCapabilities(familyOfId(m.id), m.can_edit, upscaler?.downloaded ?? false),
			'local'
		);
	}

	async function refreshModels() {
		models = await invoke<ImageModelInfo[]>('image_models').catch(
			loggedFallback([], 'settings', 'could not list the image models')
		);
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

	async function downloadModel(m: ImageModelInfo) {
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
	const editingBytes = (m: ImageModelInfo) =>
		m.files.filter((f) => f.optional).reduce((n, f) => n + f.size_bytes, 0);

	/** The optional vision weights for a model already downloaded, so it can edit. */
	async function addEditing(m: ImageModelInfo) {
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

	async function selectModel(m: ImageModelInfo) {
		model = m.id;
		patch({ model });
		await refreshEngine();
	}

	async function deleteModel(m: ImageModelInfo) {
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
		if (model === m.id) {
			model = '';
			patch({ model });
		}
		await refreshModels();
		await refreshEngine();
	}

	let engine = $state<{ status: string; model: string | null } | null>(null);
	let engineLogs = $state<string[]>([]);
	let engineBusy = $state(false);

	async function refreshEngine() {
		try {
			const st = await invoke<{
				status: { type: string; message?: string };
				model: string | null;
			}>('image_engine_status');
			engine = {
				status: st.status.type === 'Error' ? (st.status.message ?? 'Error') : st.status.type,
				model: st.model
			};
		} catch {
			engine = null;
		}
	}

	async function startEngine() {
		engineBusy = true;
		try {
			await invoke('image_engine_start', { modelId: model.trim() });
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
		if (isLocal) {
			void refreshModels();
			void refreshEngine();
		}
	});

	// --- Test generation --------------------------------------------------------

	let generating = $state(false);
	let testError = $state('');
	let testHash = $state('');
	let testProgress = $state('');
	let controller: AbortController | null = null;

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
				backend: backendForEntry(current()),
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

<div class="fields">
	<label for="image-name">Name:</label>
	<input
		id="image-name"
		type="text"
		title="What the tools call it. Leave empty for the model's own name."
		bind:value={name}
		onblur={saveName}
	/>

	<label for="image-backend">Backend:</label>
	<select id="image-backend" value={backend} onchange={chooseBackend}>
		<option value="comfyui">ComfyUI</option>
		{#if engineAvailable !== false || backend === 'local'}
			<option value="local">Bundled engine</option>
		{/if}
		<option value="lemonade">Lemonade</option>
		<option value="llama-toolchest">llama-toolchest</option>
	</select>
</div>

{#if isLocal}
	<h3>Bundled engine</h3>
	{#each models as m (m.id)}
		<div class="model" class:selected={model === m.id}>
			<div class="model-head">
				<strong>{m.description}</strong>
				{#if model === m.id}<span class="badge">selected</span>{/if}
			</div>
			<p class="help" title={m.files.map((f) => `${f.role}: ${f.filename}`).join('\n')}>
				{m.license}
				<a href={m.license_url} target="_blank" rel="noreferrer">Full text</a>
				· {formatGigabytes(m.size_bytes)} in {m.files.filter((f) => !f.optional).length} files
			</p>
			{#if !m.commercial_use}
				<p class="warn">Not licensed for commercial use.</p>
			{/if}
			{@render canLine(localLine(m))}
			<div class="row">
				{#if m.downloaded}
					<button onclick={() => selectModel(m)} disabled={model === m.id}>Use</button>
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

	<p class="help" title="Two bundled-engine models take turns: the engine restarts between them.">
		Nothing starts until you ask.
	</p>
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
{/if}

{#if server && serverKind}
	<div class="fields">
		<ServerAddress
			kind={serverKind}
			id="image-url"
			placeholder={server.placeholder}
			{keyId}
			bind:value={url}
			onCommit={saveUrl}
			onPick={pickServer}
		/>

		<label for="image-key">API key:</label>
		<div id="image-key" title="Keys are kept in Settings → Inference → API Keys.">
			<ApiKeyPicker selectedId={keyId} onSelect={chooseKey} />
		</div>

		<label for="image-model">
			Model:
			<Tooltip label="About the model" text={server.modelTip} />
		</label>
		<select
			id="image-model"
			value={model}
			onchange={chooseModel}
			disabled={modelOptions.length === 0}
		>
			{#if modelOptions.length === 0}
				<option value="">Probe to list the server's models</option>
			{:else if !model}
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
		{@render canLine(capabilityLine(capabilities, backend))}
	{/if}

	{#if probeCount > 0}
		{#if isComfy}
			<ComfyModels baseUrl={url.trim()} {apiKey} {probeCount} onInstalled={() => void probe()} />
		{:else if isToolchest}
			<ToolchestModels kind="image" instances={toolchestInstances} baseUrl={url.trim()} />
		{:else}
			<LemonadeModels {probeCount} onInstalled={() => void probe()} />
		{/if}
	{/if}
{/if}

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

{#if isComfy}
	<details>
		<summary>Custom workflow</summary>
		<div class="fields">
			<label for="image-workflow">Workflow:</label>
			<input
				id="image-workflow"
				type="text"
				placeholder="API-format workflow JSON"
				bind:value={workflowPath}
				onblur={saveWorkflow}
			/>

			<label for="image-fieldmap">Field map:</label>
			<input
				id="image-fieldmap"
				type="text"
				placeholder="field map JSON"
				bind:value={fieldMapPath}
				onblur={saveWorkflow}
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

	h3 {
		margin: 12px 0 4px;
		font-size: 1em;
	}
</style>
