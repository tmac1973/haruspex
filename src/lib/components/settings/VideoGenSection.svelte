<script lang="ts">
	/**
	 * Settings → Video generation: the video models `generate_video` and
	 * video-sequence jobs use, in the order they try them
	 * (`#lib/videogen/route.ts`). One row's editor is open at a time.
	 */
	import GenerationModelList from '#lib/components/settings/GenerationModelList.svelte';
	import UpscalerSection from '#lib/components/settings/UpscalerSection.svelte';
	import VideoEntryEditor from '#lib/components/settings/VideoEntryEditor.svelte';
	import { toolchestHint, inferenceToolchest } from '#lib/toolchest/detect.ts';
	import { hostOf } from '#lib/toolchest/client.ts';
	import {
		VIDEO_BACKEND_LABEL,
		addVideoModel,
		moveVideoModel,
		removeVideoModel,
		videoEntries
	} from '#lib/videogen/entries.ts';
	import { videoCapabilityLine } from '#lib/videogen/capabilityLine.ts';
	import { videoBackendKinds } from '#lib/videogen/index.ts';
	import { invalidateTypeAvailability } from '#lib/agent/jobs/types/availability.svelte.ts';
	import type { VideoModelEntry } from '#lib/videogen/types.ts';

	let entries = $state<VideoModelEntry[]>(videoEntries());
	const refresh = () => (entries = videoEntries());
	let openId = $state<string | null>(null);

	/** "llama-toolchest on host has video models", while there are none here. */
	let hint = $state<{ host: string; count: number } | null>(null);
	void toolchestHint('video').then((h) => (hint = h));

	function place(e: VideoModelEntry): string {
		if (e.backend === 'openrouter') return VIDEO_BACKEND_LABEL.openrouter;
		const host = e.url.trim() ? hostOf(e.url) : 'no address';
		return `${VIDEO_BACKEND_LABEL[e.backend]} on ${host}`;
	}

	function add() {
		// The inference server, when it is a toolchest, usually has the video models too.
		const found = inferenceToolchest();
		openId = found
			? addVideoModel('llama-toolchest', { url: found.baseUrl, keyId: found.apiKeyId })
			: addVideoModel(videoBackendKinds().includes('comfyui') ? 'comfyui' : 'llama-toolchest');
		refresh();
		invalidateTypeAvailability();
	}

	function remove(e: VideoModelEntry) {
		removeVideoModel(e.id);
		refresh();
		if (openId === e.id) openId = null;
		invalidateTypeAvailability();
	}
</script>

<section class="settings-section">
	<h2>Video models</h2>
	<p
		class="help"
		title="A model that doesn't answer is passed over for the next one that can make the clip. The chat model can also name one."
	>
		Video generation uses the first model in this list that can make the clip.
	</p>
	{#if entries.length === 0}
		<p class="help">None yet; video generation is off until you add one.</p>
		{#if hint}
			<p class="help">llama-toolchest on {hint.host} has video models.</p>
		{/if}
	{/if}

	<GenerationModelList
		{entries}
		{place}
		capsLine={(e) => (e.caps ? videoCapabilityLine(e.caps) : null)}
		onMove={(id, delta) => (moveVideoModel(id, delta), refresh())}
		onRemove={remove}
		bind:openId
	>
		{#snippet editor(e: VideoModelEntry)}
			<VideoEntryEditor entry={e} onChange={refresh} />
		{/snippet}
	</GenerationModelList>

	<div class="actions">
		<button onclick={add}>Add model</button>
	</div>
</section>

<UpscalerSection kind="video" />

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
</style>
