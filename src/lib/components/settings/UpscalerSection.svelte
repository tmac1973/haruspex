<script lang="ts">
	/**
	 * The Upscalers list of Settings → Image generation or Settings → Video generation:
	 * the upscalers `upscale_image` or `upscale_video` use, in order
	 * (`#lib/upscale/entries.ts`). One row's editor is open at a time.
	 */
	import GenerationModelList from '#lib/components/settings/GenerationModelList.svelte';
	import UpscalerEntryEditor from '#lib/components/settings/UpscalerEntryEditor.svelte';
	import { inferenceToolchest } from '#lib/toolchest/detect.ts';
	import { hostOf } from '#lib/toolchest/client.ts';
	import { imageEntries } from '#lib/image/entries.ts';
	import { videoEntries } from '#lib/videogen/entries.ts';
	import {
		addUpscaler,
		moveUpscaler,
		removeUpscaler,
		upscalerEntries
	} from '#lib/upscale/entries.ts';
	import { upscalerCapsLine } from '#lib/upscale/toolchest.ts';
	import type { UpscalerEntry, UpscalerKind } from '#lib/upscale/types.ts';

	interface Props {
		kind: UpscalerKind;
	}

	let { kind }: Props = $props();

	// svelte-ignore state_referenced_locally
	let entries = $state<UpscalerEntry[]>(upscalerEntries(kind));
	const refresh = () => (entries = upscalerEntries(kind));
	let openId = $state<string | null>(null);

	const HELP: Record<UpscalerKind, { line: string; title: string }> = {
		image: {
			line: 'Upscaling pictures uses the first upscaler here that answers.',
			title:
				'llama-toolchest upscaler instances. With none here, the bundled engine, ComfyUI and Lemonade upscale with their own upscaler.'
		},
		video: {
			line: 'Upscaling clips uses the first upscaler here that fits the clip.',
			title:
				'llama-toolchest video upscalers (RelayVSR, SeedVR2). One fits when it makes the scale asked for and was measured for a clip that size.'
		}
	};

	function place(e: UpscalerEntry): string {
		return `llama-toolchest on ${e.url.trim() ? hostOf(e.url) : 'no address'}`;
	}

	/** A new upscaler starts on the inference server, else the first model's toolchest server. */
	function add() {
		const found = inferenceToolchest();
		const models = kind === 'image' ? imageEntries() : videoEntries();
		const model = models.find((e) => e.backend === 'llama-toolchest' && e.url.trim());
		openId = found
			? addUpscaler(kind, { url: found.baseUrl, keyId: found.apiKeyId })
			: addUpscaler(kind, { url: model?.url ?? '', keyId: model?.keyId ?? null });
		refresh();
	}

	function remove(e: UpscalerEntry) {
		removeUpscaler(kind, e.id);
		refresh();
		if (openId === e.id) openId = null;
	}
</script>

<section class="settings-section">
	<h2>Upscalers</h2>
	<p class="help" title={HELP[kind].title}>{HELP[kind].line}</p>
	{#if entries.length === 0}
		<p class="help">None yet.</p>
	{/if}

	<GenerationModelList
		{entries}
		{place}
		capsLine={(e) => (e.caps ? { text: upscalerCapsLine(e.caps) } : null)}
		onMove={(id, delta) => (moveUpscaler(kind, id, delta), refresh())}
		onRemove={remove}
		bind:openId
	>
		{#snippet editor(e: UpscalerEntry)}
			<UpscalerEntryEditor {kind} entry={e} onChange={refresh} />
		{/snippet}
	</GenerationModelList>

	<div class="actions">
		<button onclick={add}>Add upscaler</button>
	</div>
</section>

<style>
	.actions {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-top: 8px;
	}
</style>
