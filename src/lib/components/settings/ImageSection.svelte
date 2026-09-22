<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { getSettings, updateSettings } from '$lib/stores/settings';
	import Tooltip from '$lib/components/Tooltip.svelte';
	import { resolveImageBackend } from '$lib/image';
	import { invalidateTypeAvailability } from '$lib/agent/jobs/types/availability.svelte';
	import { generateOneImage } from '$lib/image/generateOne';
	import type { ImageBackendCapabilities, ImageBackendKind } from '$lib/image/types';

	let imageBackendKind = $state(getSettings().imageBackendKind);
	let imageBackendBaseUrl = $state(getSettings().imageBackendBaseUrl);
	let imageBackendApiKey = $state(getSettings().imageBackendApiKey);
	let imageComfyCheckpoint = $state(getSettings().imageComfyCheckpoint);
	let imageLocalModelPath = $state(getSettings().imageLocalModelPath);
	let imageComfyWorkflowPath = $state(getSettings().imageComfyWorkflowPath);
	let imageComfyFieldMapPath = $state(getSettings().imageComfyFieldMapPath);

	let probing = $state(false);
	let probeResult = $state<{ ok: boolean; detail: string } | null>(null);
	let capabilities = $state<ImageBackendCapabilities | null>(null);

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
			await invoke('image_engine_start', { modelPath: imageLocalModelPath.trim() });
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
		imageBackendKind = (e.currentTarget as HTMLSelectElement).value as ImageBackendKind;
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
			capabilities = probeResult.ok ? await backend.capabilities() : null;
		} catch (e) {
			probeResult = { ok: false, detail: e instanceof Error ? e.message : String(e) };
		} finally {
			probing = false;
		}
	}

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
			testError = e instanceof Error ? e.message : String(e);
		} finally {
			generating = false;
			testProgress = '';
			controller = null;
		}
	}
</script>

<section class="settings-section">
	<h2>Image backend</h2>
	<label class="row">
		<select value={imageBackendKind} onchange={persistKind} aria-label="Image backend">
			<option value="none">None</option>
			<option value="comfyui">ComfyUI</option>
			{#if engine?.available !== false}
				<option value="local">Bundled engine</option>
			{/if}
		</select>
		<span>where pictures are generated</span>
	</label>
	<p class="help">
		Off by default. Nothing is downloaded and no process starts until you pick one. Settings →
		Image.
	</p>
</section>

{#if isLocal}
	<section class="settings-section">
		<h2>Bundled engine</h2>
		<label class="row">
			<input
				type="text"
				placeholder="/path/to/model.safetensors"
				bind:value={imageLocalModelPath}
				onblur={() => persist({ imageLocalModelPath: imageLocalModelPath.trim() })}
				aria-label="Model file"
			/>
			<span>weights to load</span>
		</label>
		<p class="help">Nothing starts until you ask. Settings → Image.</p>
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
		<label class="row">
			<input
				type="text"
				placeholder="http://localhost:8188"
				bind:value={imageBackendBaseUrl}
				onblur={() => persist({ imageBackendBaseUrl: imageBackendBaseUrl.trim() })}
				aria-label="Backend URL"
			/>
			<span>server address</span>
		</label>
		<label class="row">
			<input
				type="password"
				bind:value={imageBackendApiKey}
				onblur={() => persist({ imageBackendApiKey: imageBackendApiKey.trim() })}
				aria-label="API key"
			/>
			<span>API key, if the server needs one</span>
		</label>
		<label class="row">
			<input
				type="text"
				placeholder="sd15.safetensors"
				bind:value={imageComfyCheckpoint}
				onblur={() => persist({ imageComfyCheckpoint: imageComfyCheckpoint.trim() })}
				aria-label="Default checkpoint"
			/>
			<span>
				default checkpoint
				<Tooltip
					label="About the checkpoint"
					text="The model a generation uses when nothing else names one. It must be a checkpoint the server already has; the probe below checks."
				/>
			</span>
		</label>

		<div class="actions">
			<button onclick={probe} disabled={probing}>{probing ? 'Probing…' : 'Probe'}</button>
			{#if probeResult}
				<span class="detail" class:bad={!probeResult.ok}>{probeResult.detail}</span>
			{/if}
		</div>
		{#if capabilities}
			<p class="help">
				Supports: reference conditioning {capabilities.referenceConditioning ? 'yes' : 'no'},
				seamless tiling {capabilities.seamlessTiling ? 'yes' : 'no'}, LoRA slots {capabilities.maxLoras}.
			</p>
		{/if}
	</section>

	<section class="settings-section">
		<h2>Test generation</h2>
		<div class="actions">
			<button onclick={testGeneration}>{generating ? 'Stop' : 'Generate a test image'}</button>
			{#if testProgress}<span class="detail">{testProgress}</span>{/if}
			{#if testError}<span class="detail bad">{testError}</span>{/if}
		</div>
		{#if testHash}
			<img class="preview" src={`haruspex-img://localhost/${testHash}`} alt="Test generation" />
		{/if}
		<p class="help">Makes one picture through the configured backend. Nothing else is affected.</p>
	</section>

	<details class="settings-section">
		<summary><h2>Custom workflow</h2></summary>
		<label class="row">
			<input
				type="text"
				bind:value={imageComfyWorkflowPath}
				onblur={() => persist({ imageComfyWorkflowPath: imageComfyWorkflowPath.trim() })}
				aria-label="Workflow path"
			/>
			<span>API-format workflow JSON</span>
		</label>
		<label class="row">
			<input
				type="text"
				bind:value={imageComfyFieldMapPath}
				onblur={() => persist({ imageComfyFieldMapPath: imageComfyFieldMapPath.trim() })}
				aria-label="Field map path"
			/>
			<span>field map JSON</span>
		</label>
		<p class="help">
			Replaces the built-in workflows. Set both or neither — one without the other fails the probe.
		</p>
	</details>
{/if}

<style>
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
