<script lang="ts">
	/**
	 * One video model in Settings → Video generation: its name, backend,
	 * server, key and model, a Probe that asks its own server, and the
	 * server's video instances. An OpenRouter model has no server address, and
	 * has a resolution and a limit on what one clip may cost instead.
	 */
	import { errMessage } from '#lib/utils/error.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import ComfyModels from '#lib/components/settings/ComfyModels.svelte';
	import { rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import type { GenerationServer } from '#lib/stores/settings.ts';
	import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
	import { withSavedModel } from '#lib/toolchest/kind.ts';
	import type { ToolchestInstance } from '#lib/toolchest/models.ts';
	import { videoBackendForEntry, videoBackendKinds } from '#lib/videogen/index.ts';
	import { seenToolchestVideoInstances } from '#lib/videogen/toolchest/backend.ts';
	import { DEFAULT_MAX_CLIP_USD, modelTiers } from '#lib/videogen/openrouter/backend.ts';
	import { inferenceOpenRouterKeyId } from '#lib/image/openrouter/backend.ts';
	import {
		VIDEO_BACKEND_LABEL,
		renameVideoModel,
		saveVideoCaps,
		updateVideoModel,
		videoEntryApiKey,
		videoEntryById
	} from '#lib/videogen/entries.ts';
	import type { VideoBackendKind, VideoModelEntry } from '#lib/videogen/types.ts';

	interface Props {
		entry: VideoModelEntry;
		onChange: () => void;
	}

	let { entry, onChange }: Props = $props();

	// Local copies the inputs bind to; saved on commit, not on every key.
	// svelte-ignore state_referenced_locally
	let name = $state(entry.name);
	// svelte-ignore state_referenced_locally
	let backend = $state<VideoBackendKind>(entry.backend);
	// svelte-ignore state_referenced_locally
	let url = $state(entry.url);
	// svelte-ignore state_referenced_locally
	let keyId = $state<string | null>(entry.keyId);
	// svelte-ignore state_referenced_locally
	let model = $state(entry.model);
	// svelte-ignore state_referenced_locally
	let resolution = $state(entry.options.resolution ?? '');
	// svelte-ignore state_referenced_locally
	let maxClipUsd = $state(entry.options.maxClipUsd ?? String(DEFAULT_MAX_CLIP_USD));
	/** The chosen OpenRouter model's resolutions, read after each probe. */
	let tiers = $state<string[]>([]);

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	let serverModels = $state<ModelOption[]>([]);
	let instances = $state<ToolchestInstance[]>([]);
	let probeCount = $state(0);
	/** The key ComfyUI's install card sends, read once per probe. */
	let apiKey = $state('');
	const modelOptions = $derived(withSavedModel(model, serverModels));

	type ServerKind = Exclude<VideoBackendKind, 'openrouter'>;

	const SERVER_TIPS: Record<ServerKind, { placeholder: string; model: string }> = {
		'llama-toolchest': {
			placeholder: 'http://host:3000',
			model:
				"The server's video instances, listed by Probe. A stopped one starts when it is first used."
		},
		comfyui: {
			placeholder: 'http://host:8188',
			model: "The video models in the server's diffusion_models folder that Haruspex can run."
		}
	};

	const OPENROUTER_MODEL_TIP =
		"OpenRouter's video models, listed by Probe. Each makes clips of set lengths; a clip is made at the nearest one.";

	const isOpenRouter = $derived(backend === 'openrouter');
	/** A server the user keeps, with an address; not OpenRouter. */
	const serverKind = $derived<ServerKind | null>(backend === 'openrouter' ? null : backend);

	/** The entry as saved now: the editor's copy may be behind a save made elsewhere. */
	function current(): VideoModelEntry {
		return videoEntryById(entry.id) ?? entry;
	}

	function patch(p: Partial<Omit<VideoModelEntry, 'id'>>) {
		updateVideoModel(entry.id, p);
		name = current().name;
		onChange();
	}

	async function probe() {
		const b = videoBackendForEntry(current());
		if (!b) return;
		probing = true;
		probeResult = null;
		try {
			apiKey = await videoEntryApiKey(current());
			probeResult = await b.probe();
			serverModels = probeResult.models ?? (b.models ? await b.models().catch(() => []) : []);
			probeCount++;
			if (backend === 'llama-toolchest') instances = seenToolchestVideoInstances(current());
			if (backend === 'openrouter') tiers = model ? await modelTiers(model) : [];
			if (serverKind && (probeResult.ok || serverModels.length)) {
				rememberServer(serverKind, url, keyId);
			}
			// With one model there is nothing to choose.
			if (!model && serverModels.length === 1) {
				model = serverModels[0].name;
				patch({ model });
				return probe();
			}
			if (probeResult.ok) {
				saveVideoCaps(entry.id, await b.capabilities());
				onChange();
			}
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function chooseBackend(e: Event) {
		backend = (e.currentTarget as HTMLSelectElement).value as VideoBackendKind;
		model = '';
		serverModels = [];
		instances = [];
		probeResult = null;
		tiers = [];
		resolution = '';
		maxClipUsd = String(DEFAULT_MAX_CLIP_USD);
		// The key Settings → Inference uses for OpenRouter, when there is one.
		if (backend === 'openrouter') keyId = inferenceOpenRouterKeyId() ?? keyId;
		patch({ backend, keyId, model: '', options: {} });
		if (url.trim() || backend === 'openrouter') void probe();
	}

	/** Save the resolution and the per-clip limit; a new resolution changes what the model makes. */
	function saveOpenRouterOptions() {
		const limit = maxClipUsd.trim();
		patch({ options: { resolution, maxClipUsd: limit } });
		void probe();
	}

	function pickServer(saved: GenerationServer | null) {
		url = saved?.url ?? '';
		keyId = saved?.keyId ?? keyId;
		patch({ url, keyId });
		probeResult = null;
		if (url) void probe();
	}

	function saveUrl() {
		const next = url.trim();
		if (next === current().url) return;
		patch({ url: next });
		if (next) void probe();
	}

	function chooseKey(id: string | null) {
		keyId = id;
		patch({ keyId: id });
		if (url.trim() || isOpenRouter) void probe();
	}

	function chooseModel(e: Event) {
		model = (e.currentTarget as HTMLSelectElement).value;
		patch({ model });
		void probe();
	}

	function saveName() {
		renameVideoModel(entry.id, name);
		name = current().name;
		onChange();
	}

	let probedOnOpen = false;
	$effect(() => {
		if (!probedOnOpen && (url.trim() || isOpenRouter)) {
			probedOnOpen = true;
			void probe();
		}
	});

	const chosen = $derived(instances.find((i) => i.id === model));
</script>

<div class="fields">
	<label for="video-name-{entry.id}">Name:</label>
	<input
		id="video-name-{entry.id}"
		type="text"
		bind:value={name}
		onblur={saveName}
		onkeydown={(e) => e.key === 'Enter' && saveName()}
		title="What the chat model calls it. Leave empty to use the model's name."
	/>

	<label for="video-backend-{entry.id}">Backend:</label>
	<select id="video-backend-{entry.id}" value={backend} onchange={chooseBackend}>
		{#each videoBackendKinds() as k (k)}
			<option value={k}>{VIDEO_BACKEND_LABEL[k]}</option>
		{/each}
	</select>

	{#if serverKind}
		<ServerAddress
			kind={serverKind}
			id="video-url-{entry.id}"
			placeholder={SERVER_TIPS[serverKind].placeholder}
			{keyId}
			bind:value={url}
			onCommit={saveUrl}
			onPick={pickServer}
		/>
	{/if}

	<label for="video-key-{entry.id}">API key:</label>
	<div id="video-key-{entry.id}" title="Keys are kept in Settings → Inference → API Keys.">
		<ApiKeyPicker selectedId={keyId} onSelect={chooseKey} />
	</div>

	<label for="video-model-{entry.id}">
		Model:
		<Tooltip
			label="About the model"
			text={serverKind ? SERVER_TIPS[serverKind].model : OPENROUTER_MODEL_TIP}
		/>
	</label>
	<select
		id="video-model-{entry.id}"
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

	{#if isOpenRouter}
		<label for="video-resolution-{entry.id}">Resolution:</label>
		<select
			id="video-resolution-{entry.id}"
			bind:value={resolution}
			onchange={saveOpenRouterOptions}
			disabled={tiers.length === 0}
			title="Higher resolutions cost more a second."
		>
			<option value="">{tiers.includes('720p') ? '720p' : (tiers[0] ?? 'Default')}</option>
			{#each tiers.filter((t) => t !== (tiers.includes('720p') ? '720p' : tiers[0])) as t (t)}
				<option value={t}>{t}</option>
			{/each}
		</select>

		<label for="video-limit-{entry.id}">Most per clip ($):</label>
		<input
			id="video-limit-{entry.id}"
			type="number"
			min="0"
			step="0.5"
			bind:value={maxClipUsd}
			onblur={saveOpenRouterOptions}
			title="A clip that would cost more is not made, and goes to the next model. OpenRouter can't cancel a clip once it is sent. 0 is no limit."
		/>
	{/if}
</div>

{#if isOpenRouter}
	<p class="help" title="Each clip is paid for from the key's OpenRouter credit.">
		Prompts and pictures are sent to OpenRouter.
	</p>
{/if}

<div class="actions">
	<button onclick={probe} disabled={probing || (!url.trim() && !isOpenRouter)}>
		{probing ? 'Probing…' : 'Probe'}
	</button>
	{#if probeResult}
		<span class="detail" class:bad={!probeResult.ok}>{probeResult.detail}</span>
	{/if}
</div>

{#if backend === 'llama-toolchest' && chosen?.video?.maxPixelFrames}
	<p
		class="help"
		title="Measure the instance at a larger size on llama-toolchest's Server page for longer clips."
	>
		{chosen.id} is measured for {chosen.video.maxPixelFrames.toLocaleString()} pixel-frames.
	</p>
{/if}

{#if backend === 'llama-toolchest' && probeCount > 0 && instances.length > 0}
	<ToolchestModels kind="video" {instances} baseUrl={url.trim()} />
{/if}

{#if backend === 'comfyui' && probeCount > 0 && probeResult && (probeResult.ok || probeResult.models)}
	<ComfyModels
		kind="video"
		baseUrl={url.trim()}
		{apiKey}
		{probeCount}
		onInstalled={() => void probe()}
	/>
{/if}

<style>
	.fields {
		display: grid;
		grid-template-columns: max-content minmax(0, 1fr);
		align-items: center;
		gap: 8px 12px;
	}

	.fields select,
	.fields input {
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
