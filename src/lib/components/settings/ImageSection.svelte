<script lang="ts">
	/**
	 * Settings → Image generation: the image models the image tools use, in the order they
	 * try them (`#lib/image/route.ts`). One row's editor is open at a time.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import ImageEntryEditor from '#lib/components/settings/ImageEntryEditor.svelte';
	import GenerationModelList from '#lib/components/settings/GenerationModelList.svelte';
	import UpscalerSection from '#lib/components/settings/UpscalerSection.svelte';
	import { toolchestHint, inferenceToolchest } from '#lib/toolchest/detect.ts';
	import { hostOf } from '#lib/toolchest/client.ts';
	import {
		IMAGE_BACKEND_LABEL,
		addImageModel,
		allImageEntries,
		imageEntries,
		moveImageModel,
		removeImageModel,
		setImageModelEnabled
	} from '#lib/image/entries.ts';
	import { capabilityLine } from '#lib/image/capabilityLine.ts';
	import { invalidateTypeAvailability } from '#lib/agent/jobs/types/availability.svelte.ts';
	import type { ImageModelEntry } from '#lib/image/types.ts';

	/** The list as saved, read again after every change made here or in the editor. */
	let entries = $state<ImageModelEntry[]>(allImageEntries());
	const refresh = () => (entries = allImageEntries());
	let openId = $state<string | null>(null);

	/** "llama-toolchest on host has image models", while there are none here. */
	let hint = $state<{ host: string; count: number } | null>(null);
	void toolchestHint('image').then((h) => (hint = h));

	/** Whether this platform has a bundled engine. Asked once: it is a property of the install. */
	let engineAvailable = $state<boolean | null>(null);
	void invoke<{ available: boolean }>('image_engine_status')
		.then((st) => (engineAvailable = st.available))
		.catch(() => (engineAvailable = null));

	/** Where an entry runs, for its row. */
	function place(e: ImageModelEntry): string {
		if (e.backend === 'local' || e.backend === 'openrouter') return IMAGE_BACKEND_LABEL[e.backend];
		const host = e.url.trim() ? hostOf(e.url) : 'no address';
		return `${IMAGE_BACKEND_LABEL[e.backend]} on ${host}`;
	}

	function add() {
		// The inference server, when it is a toolchest, is usually where the
		// image models are too.
		const found = inferenceToolchest();
		openId = found
			? addImageModel('llama-toolchest', { url: found.baseUrl, keyId: found.apiKeyId })
			: addImageModel('comfyui');
		refresh();
		invalidateTypeAvailability();
	}

	/** The engine holds ~7 GB of VRAM; let it go when no other model that is on uses it. */
	function releaseEngine(e: ImageModelEntry) {
		if (
			e.backend === 'local' &&
			!imageEntries().some((o) => o.id !== e.id && o.backend === 'local')
		) {
			void invoke('image_engine_stop').catch(() => {});
		}
	}

	function enable(e: ImageModelEntry, on: boolean) {
		if (!on) releaseEngine(e);
		setImageModelEnabled(e.id, on);
		refresh();
		invalidateTypeAvailability();
	}

	function remove(e: ImageModelEntry) {
		releaseEngine(e);
		removeImageModel(e.id);
		refresh();
		if (openId === e.id) openId = null;
		invalidateTypeAvailability();
	}
</script>

<section class="settings-section">
	<h2>Image models</h2>
	<p
		class="help"
		title="A model that doesn't answer is passed over for the next one that can do the job. The chat model can also name one."
	>
		Image tools use the first model in this list that can do the job.
	</p>
	{#if entries.length === 0}
		<p class="help">None yet; nothing is downloaded or started before you add one.</p>
		{#if hint}
			<p class="help">llama-toolchest on {hint.host} has image models.</p>
		{/if}
	{/if}

	<GenerationModelList
		{entries}
		{place}
		capsLine={(e) => {
			if (!e.caps) return null;
			const line = capabilityLine(e.caps, e.backend);
			return { text: line.text, title: line.howTo };
		}}
		onMove={(id, delta) => (moveImageModel(id, delta), refresh())}
		onEnable={enable}
		onRemove={remove}
		bind:openId
	>
		{#snippet editor(e: ImageModelEntry)}
			<ImageEntryEditor entry={e} {engineAvailable} onChange={refresh} />
		{/snippet}
	</GenerationModelList>

	<div class="actions">
		<button onclick={add}>Add model</button>
	</div>
</section>

<UpscalerSection kind="image" />

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
</style>
