<script module lang="ts">
	function sizeArea(size: string): number {
		const [w, h] = size.split('x').map(Number);
		return w > 0 && h > 0 ? w * h : 1;
	}
</script>

<script lang="ts">
	/**
	 * Settings → Video generation: a llama-toolchest server's video instances,
	 * as Settings → Music's toolchest part does for songs. Off until a backend
	 * is picked; `generate_video` is offered only then.
	 */
	import { errMessage } from '#lib/utils/error.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ToolchestModels from '#lib/components/settings/ToolchestModels.svelte';
	import { probeVideo, seenVideoInstances } from '#lib/videogen/toolchest.ts';
	import type { ModelOption, ProbeResult } from '#lib/image/backend.ts';
	import { toolchestHint } from '#lib/toolchest/detect.ts';
	import { prefillFromInference, withSavedModel } from '#lib/toolchest/kind.ts';
	import type { ToolchestInstance } from '#lib/toolchest/models.ts';

	type Kind = 'none' | 'llama-toolchest';

	let kind = $state<Kind>(getSettings().videoGenBackendKind);
	let baseUrl = $state(getSettings().videoGenToolchestBaseUrl);
	let apiKeyId = $state<string | null>(getSettings().videoGenToolchestApiKeyId);
	let modelId = $state(getSettings().videoGenToolchestModelId);

	const isToolchest = $derived(kind === 'llama-toolchest');

	let probing = $state(false);
	let probeResult = $state<ProbeResult | null>(null);
	let serverModels = $state<ModelOption[]>([]);
	let instances = $state<ToolchestInstance[]>([]);
	const modelOptions = $derived(withSavedModel(modelId, serverModels));
	const chosen = $derived(instances.find((i) => i.id === modelId));

	let hint = $state<{ host: string; count: number } | null>(null);
	void toolchestHint('video').then((h) => (hint = h));

	function persistKind(e: Event) {
		kind = (e.currentTarget as HTMLSelectElement).value as Kind;
		updateSettings({ videoGenBackendKind: kind });
		const found = kind === 'llama-toolchest' ? prefillFromInference('video') : null;
		if (found) {
			baseUrl = found.baseUrl;
			apiKeyId = found.apiKeyId;
		}
		probeResult = null;
		serverModels = [];
		if (isToolchest && baseUrl.trim()) void probe();
	}

	async function probe() {
		probing = true;
		probeResult = null;
		try {
			probeResult = await probeVideo();
			if (probeResult.models) serverModels = probeResult.models;
			instances = seenVideoInstances();
			// With one instance there is nothing to choose.
			if (!modelId && instances.length === 1) {
				modelId = instances[0].id;
				updateSettings({ videoGenToolchestModelId: modelId });
				probeResult = await probeVideo();
			}
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e) };
		} finally {
			probing = false;
		}
	}

	function saveUrl() {
		const next = baseUrl.trim();
		const changed = next !== getSettings().videoGenToolchestBaseUrl;
		updateSettings({ videoGenToolchestBaseUrl: next });
		if (changed && next) void probe();
	}

	function chooseKey(id: string | null) {
		apiKeyId = id;
		updateSettings({ videoGenToolchestApiKeyId: id });
		if (baseUrl.trim()) void probe();
	}

	function chooseModel(e: Event) {
		modelId = (e.currentTarget as HTMLSelectElement).value;
		updateSettings({ videoGenToolchestModelId: modelId });
		void probe();
	}

	let probedOnOpen = false;
	$effect(() => {
		if (!probedOnOpen && isToolchest && baseUrl.trim()) {
			probedOnOpen = true;
			void probe();
		}
	});
</script>

<section class="settings-section">
	<h2>Video generation backend</h2>
	<div class="fields">
		<label for="videogen-backend">Backend:</label>
		<select id="videogen-backend" value={kind} onchange={persistKind}>
			<option value="none">None</option>
			<option value="llama-toolchest">llama-toolchest</option>
		</select>
	</div>
	<p class="help">Off until you pick one.</p>
	{#if hint && kind === 'none'}
		<p class="help">llama-toolchest on {hint.host} has video models.</p>
	{/if}
</section>

{#if isToolchest}
	<section class="settings-section">
		<h2>Connection</h2>
		<div class="fields">
			<label for="videogen-url">Server address:</label>
			<input
				id="videogen-url"
				type="text"
				placeholder="http://host:3000"
				bind:value={baseUrl}
				onblur={saveUrl}
			/>

			<label for="videogen-key">API key:</label>
			<div id="videogen-key" title="Keys are kept in Settings → Inference → API Keys.">
				<ApiKeyPicker selectedId={apiKeyId} onSelect={chooseKey} />
			</div>

			<label for="videogen-model">
				Model:
				<Tooltip
					label="About the model"
					text="The server's video instances, listed by Probe. One must be running to make a clip; start it in llama-toolchest."
				/>
			</label>
			<select
				id="videogen-model"
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
		{#if chosen?.video}
			<p
				class="help"
				title="Measure the instance at a larger size on llama-toolchest's Server page for longer clips."
			>
				{chosen.id} makes {chosen.video.defaultSize} at {chosen.video.defaultFps} fps{chosen.video
					.maxPixelFrames
					? `, up to ${Math.floor(chosen.video.maxPixelFrames / sizeArea(chosen.video.defaultSize))} frames at that size`
					: ''}.
			</p>
		{/if}
	</section>

	{#if probeResult?.models}
		<ToolchestModels kind="video" {instances} baseUrl={baseUrl.trim()} />
	{/if}
{/if}

<style>
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
