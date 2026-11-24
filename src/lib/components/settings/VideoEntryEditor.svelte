<script lang="ts">
	/**
	 * One video model in Settings → Video generation: its name, backend,
	 * server, key and model, a Probe that asks its own server, and the
	 * server's video instances.
	 */
	import { errMessage } from '#lib/utils/error.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import { rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import type { GenerationServer } from '#lib/stores/settings.ts';
	import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
	import { withSavedModel } from '#lib/toolchest/kind.ts';
	import type { ToolchestInstance } from '#lib/toolchest/models.ts';
	import { videoBackendForEntry, videoBackendKinds } from '#lib/videogen/index.ts';
	import { seenToolchestVideoInstances } from '#lib/videogen/toolchest/backend.ts';
	import {
		VIDEO_BACKEND_LABEL,
		renameVideoModel,
		saveVideoCaps,
		updateVideoModel,
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

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	let serverModels = $state<ModelOption[]>([]);
	let instances = $state<ToolchestInstance[]>([]);
	let probeCount = $state(0);
	const modelOptions = $derived(withSavedModel(model, serverModels));

	const SERVER_TIPS: Record<VideoBackendKind, { placeholder: string; model: string }> = {
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
			probeResult = await b.probe();
			serverModels = probeResult.models ?? (b.models ? await b.models().catch(() => []) : []);
			probeCount++;
			if (backend === 'llama-toolchest') instances = seenToolchestVideoInstances(current());
			if (probeResult.ok || serverModels.length) rememberServer(backend, url, keyId);
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
		patch({ backend, model: '', options: {} });
		if (url.trim()) void probe();
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
		if (url.trim()) void probe();
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
		if (!probedOnOpen && url.trim()) {
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

	<ServerAddress
		kind={backend}
		id="video-url-{entry.id}"
		placeholder={SERVER_TIPS[backend].placeholder}
		{keyId}
		bind:value={url}
		onCommit={saveUrl}
		onPick={pickServer}
	/>

	<label for="video-key-{entry.id}">API key:</label>
	<div id="video-key-{entry.id}" title="Keys are kept in Settings → Inference → API Keys.">
		<ApiKeyPicker selectedId={keyId} onSelect={chooseKey} />
	</div>

	<label for="video-model-{entry.id}">
		Model:
		<Tooltip label="About the model" text={SERVER_TIPS[backend].model} />
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
</div>

<div class="actions">
	<button onclick={probe} disabled={probing || !url.trim()}>
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
