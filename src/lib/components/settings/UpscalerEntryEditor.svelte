<script lang="ts">
	/**
	 * One upscaler in Settings → Image generation or Settings → Video generation →
	 * Upscalers: its name, llama-toolchest server, key and upscaler instance,
	 * and a Probe that asks the server.
	 */
	import { errMessage } from '#lib/utils/error.ts';
	import Tooltip from '#lib/components/Tooltip.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ServerAddress from '#lib/components/settings/ServerAddress.svelte';
	import { pickedServer, rememberServer } from '#lib/stores/generationServers.svelte.ts';
	import type { GenerationServer } from '#lib/stores/settings.ts';
	import { withSavedModel } from '#lib/toolchest/kind.ts';
	import { renameUpscaler, updateUpscaler, upscalerById } from '#lib/upscale/entries.ts';
	import { probeUpscaler, type UpscalerProbe } from '#lib/upscale/toolchest.ts';
	import type { UpscalerEntry, UpscalerKind } from '#lib/upscale/types.ts';

	interface Props {
		kind: UpscalerKind;
		entry: UpscalerEntry;
		onChange: () => void;
	}

	let { kind, entry, onChange }: Props = $props();

	// Local copies the inputs bind to; saved on commit, not on every key.
	// svelte-ignore state_referenced_locally
	let name = $state(entry.name);
	// svelte-ignore state_referenced_locally
	let url = $state(entry.url);
	// svelte-ignore state_referenced_locally
	let keyId = $state<string | null>(entry.keyId);
	// svelte-ignore state_referenced_locally
	let model = $state(entry.model);

	let probing = $state(false);
	let probeResult = $state<UpscalerProbe | null>(null);
	const modelOptions = $derived(withSavedModel(model, probeResult?.models ?? []));
	const idBase = $derived(`${kind}-upscaler-${entry.id}`);

	const TIP: Record<UpscalerKind, string> = {
		image: "The server's picture upscalers (Real-ESRGAN), listed by Probe.",
		video: "The server's video upscalers (RelayVSR, SeedVR2), listed by Probe."
	};

	/** The entry as saved now: the editor's copy may be behind a save made elsewhere. */
	function current(): UpscalerEntry {
		return upscalerById(kind, entry.id) ?? entry;
	}

	function patch(p: Partial<Omit<UpscalerEntry, 'id'>>) {
		updateUpscaler(kind, entry.id, p);
		name = current().name;
		onChange();
	}

	async function probe() {
		probing = true;
		probeResult = null;
		try {
			probeResult = await probeUpscaler(kind, current());
			if (probeResult.ok || probeResult.models.length) {
				rememberServer('llama-toolchest', url, keyId);
			}
			// With one upscaler there is nothing to choose.
			if (!model && probeResult.models.length === 1) {
				model = probeResult.models[0].name;
				patch({ model });
				return probe();
			}
			onChange();
		} catch (e) {
			probeResult = { ok: false, detail: errMessage(e), models: [] };
		} finally {
			probing = false;
		}
	}

	function pickServer(saved: GenerationServer | null) {
		({ url, keyId } = pickedServer(saved, keyId));
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
		renameUpscaler(kind, entry.id, name);
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
</script>

<div class="fields">
	<label for="{idBase}-name">Name:</label>
	<input
		id="{idBase}-name"
		type="text"
		bind:value={name}
		onblur={saveName}
		onkeydown={(e) => e.key === 'Enter' && saveName()}
		title="What the chat model calls it. Leave empty to use the upscaler's name."
	/>

	<ServerAddress
		kind="llama-toolchest"
		id="{idBase}-url"
		placeholder="http://host:3000"
		{keyId}
		bind:value={url}
		onCommit={saveUrl}
		onPick={pickServer}
	/>

	<label for="{idBase}-key">API key:</label>
	<div id="{idBase}-key" title="Keys are kept in Settings → Inference → API Keys.">
		<ApiKeyPicker selectedId={keyId} onSelect={chooseKey} />
	</div>

	<label for="{idBase}-model">
		Upscaler:
		<Tooltip label="About the upscaler" text={TIP[kind]} />
	</label>
	<select
		id="{idBase}-model"
		value={model}
		onchange={chooseModel}
		disabled={modelOptions.length === 0}
	>
		{#if modelOptions.length === 0}
			<option value="">Probe to list the server's upscalers</option>
		{:else if !model}
			<option value="" disabled>Choose an upscaler</option>
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
