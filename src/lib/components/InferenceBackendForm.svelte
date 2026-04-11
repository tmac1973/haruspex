<script lang="ts">
	/**
	 * Reusable form for configuring a remote inference backend — a
	 * URL + optional API key + test-connection button that probes the
	 * server, detects its shape (llama-toolchest / llama-server /
	 * OpenAI-compat / Ollama), populates a model dropdown, and surfaces
	 * detected context size + vision capability. Used both in the
	 * Settings page (for post-setup reconfiguration) and the first-run
	 * wizard (for choosing remote as the initial backend) — same
	 * probe flow either way, so factoring it out keeps the two call
	 * sites in sync.
	 */
	import { invoke } from '@tauri-apps/api/core';
	import { untrack } from 'svelte';
	import type { InferenceBackendConfig, InferenceBackendKind } from '$lib/stores/settings';

	interface NormalizedModel {
		id: string;
		display_name: string;
		context_size: number | null;
		vision_supported: boolean | null;
		loaded: boolean | null;
	}

	interface ProbeResult {
		base_url: string;
		kind: InferenceBackendKind;
		models: NormalizedModel[];
		default_context_size: number | null;
		notes: string;
	}

	interface Props {
		config: InferenceBackendConfig;
		onConfigChange: (next: InferenceBackendConfig) => void;
	}

	let { config, onConfigChange }: Props = $props();

	// Mirror the config into local editable state. We commit back via
	// onConfigChange after each meaningful user action (probe success,
	// model selection, etc.) so the parent can persist. We capture the
	// initial values once at mount — the form owns the editing state
	// from that point forward and only sync down via the parent reload.
	let baseUrl = $state(untrack(() => config.remoteBaseUrl));
	let apiKey = $state(untrack(() => config.remoteApiKey));
	let modelId = $state(untrack(() => config.remoteModelId));
	let manualContextSize = $state<number | ''>(untrack(() => config.remoteContextSize ?? ''));
	let visionOverride = $state<boolean | null>(untrack(() => config.remoteVisionSupported));

	let probing = $state(false);
	let probeError = $state<string | null>(null);
	let probeResult = $state<ProbeResult | null>(null);
	// Track whether the detected context size came from the probe —
	// drives whether the manual-entry field is editable or readonly.
	let contextDetected = $derived(
		probeResult?.default_context_size !== null && probeResult?.default_context_size !== undefined
	);
	let visionDetected = $derived(
		probeResult?.models.some((m) => m.id === modelId && m.vision_supported !== null) ?? false
	);

	function commit(partial: Partial<InferenceBackendConfig>) {
		onConfigChange({ ...config, ...partial });
	}

	async function testConnection() {
		probing = true;
		probeError = null;
		try {
			const result = await invoke<ProbeResult>('probe_inference_server', {
				baseUrl,
				apiKey: apiKey || null
			});
			probeResult = result;
			// Commit the normalized URL (the Rust side may have stripped
			// a trailing slash or /v1 suffix), and pick a sensible default
			// model: prefer the current selection if it's still in the
			// list, otherwise take the first loaded model, otherwise the
			// first model overall.
			const existing = result.models.find((m) => m.id === modelId);
			const firstLoaded = result.models.find((m) => m.loaded === true);
			const pick = existing ?? firstLoaded ?? result.models[0];
			if (pick) {
				modelId = pick.id;
			}
			// Use the probe's detected context size, or keep the manual
			// value the user had previously entered.
			if (result.default_context_size !== null && result.default_context_size !== undefined) {
				manualContextSize = result.default_context_size;
			}
			// Vision: if the selected model carries a concrete flag, use it;
			// otherwise leave the manual override alone.
			const selectedModel = result.models.find((m) => m.id === modelId);
			if (selectedModel?.vision_supported !== null && selectedModel !== undefined) {
				visionOverride = selectedModel?.vision_supported ?? null;
			}
			commit({
				remoteBaseUrl: result.base_url,
				remoteApiKey: apiKey,
				remoteModelId: modelId,
				remoteContextSize: typeof manualContextSize === 'number' ? manualContextSize : null,
				remoteVisionSupported: visionOverride,
				remoteBackendKind: result.kind
			});
		} catch (e) {
			probeError = String(e);
			probeResult = null;
		} finally {
			probing = false;
		}
	}

	function onModelChange(newId: string) {
		modelId = newId;
		// If the newly selected model has its own context/vision metadata,
		// auto-fill those fields.
		const m = probeResult?.models.find((x) => x.id === newId);
		if (m) {
			if (typeof m.context_size === 'number') {
				manualContextSize = m.context_size;
			}
			if (m.vision_supported !== null) {
				visionOverride = m.vision_supported;
			}
		}
		commit({
			remoteModelId: newId,
			remoteContextSize: typeof manualContextSize === 'number' ? manualContextSize : null,
			remoteVisionSupported: visionOverride
		});
	}

	function onContextChange(val: string) {
		const parsed = parseInt(val, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			manualContextSize = parsed;
			commit({ remoteContextSize: parsed });
		} else {
			manualContextSize = '';
			commit({ remoteContextSize: null });
		}
	}

	function onVisionToggle(val: boolean) {
		visionOverride = val;
		commit({ remoteVisionSupported: val });
	}

	function backendDisplayName(kind: InferenceBackendKind): string {
		switch (kind) {
			case 'llama-toolchest':
				return 'llama-toolchest';
			case 'llama-server':
				return 'llama-server';
			case 'openai-compat':
				return 'OpenAI-compatible';
			case 'ollama':
				return 'Ollama';
			default:
				return 'Unknown';
		}
	}
</script>

<div class="inference-form">
	<div class="field">
		<label for="inf-base-url">Server URL</label>
		<input
			id="inf-base-url"
			type="text"
			placeholder="http://localhost:8080"
			bind:value={baseUrl}
			onblur={() => commit({ remoteBaseUrl: baseUrl })}
		/>
		<p class="hint">
			The base URL of your inference server. Examples:
			<code>http://localhost:11434</code> (Ollama),
			<code>http://localhost:1234</code> (LM Studio),
			<code>http://10.0.0.5:8080</code> (llama-server or llama-toolchest).
		</p>
	</div>

	<div class="field">
		<label for="inf-api-key">API Key (optional)</label>
		<input
			id="inf-api-key"
			type="password"
			placeholder="Leave blank for self-hosted servers"
			bind:value={apiKey}
			onblur={() => commit({ remoteApiKey: apiKey })}
		/>
		<p class="hint">
			Only needed for servers that require authentication. Sent as
			<code>Authorization: Bearer …</code>.
		</p>
	</div>

	<div class="test-row">
		<button class="btn btn-primary" onclick={testConnection} disabled={probing || !baseUrl}>
			{probing ? 'Testing…' : 'Test connection'}
		</button>
		{#if probeResult}
			<span class="probe-status detected">
				✓ Detected: {backendDisplayName(probeResult.kind)} — {probeResult.notes}
			</span>
		{/if}
		{#if probeError}
			<span class="probe-status error">✗ {probeError}</span>
		{/if}
	</div>

	{#if probeResult && probeResult.models.length > 0}
		<div class="field">
			<label for="inf-model">Model</label>
			<select
				id="inf-model"
				value={modelId}
				onchange={(e) => onModelChange((e.target as HTMLSelectElement).value)}
			>
				{#each probeResult.models as m (m.id)}
					<option value={m.id}>
						{m.display_name}{m.loaded === false ? ' (not loaded)' : ''}
					</option>
				{/each}
			</select>
		</div>

		<div class="field">
			<label for="inf-ctx">Context size (tokens)</label>
			<input
				id="inf-ctx"
				type="number"
				min="512"
				step="512"
				placeholder="e.g. 32768"
				value={manualContextSize}
				oninput={(e) => onContextChange((e.target as HTMLInputElement).value)}
				readonly={contextDetected}
			/>
			<p class="hint">
				{#if contextDetected}
					Detected from the server. Haruspex uses this value to decide when to compact long
					conversations.
				{:else}
					Not detected — enter the max context length your selected model supports. This sets when
					Haruspex compacts long conversations.
				{/if}
			</p>
		</div>

		<div class="field">
			<label class="toggle-row">
				<input
					type="checkbox"
					checked={visionOverride === true}
					onchange={(e) => onVisionToggle((e.target as HTMLInputElement).checked)}
				/>
				<div>
					<strong>This model supports vision (image input)</strong>
					<span>
						{#if visionDetected}
							Detected automatically from the backend.
						{:else}
							Haruspex couldn't auto-detect. Only enable if you know your model is multimodal —
							sending images to a text-only model will error.
						{/if}
					</span>
				</div>
			</label>
		</div>
	{/if}
</div>

<style>
	.inference-form {
		display: flex;
		flex-direction: column;
		gap: 16px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field label {
		font-size: 0.85rem;
		font-weight: 500;
	}

	.field input[type='text'],
	.field input[type='password'],
	.field input[type='number'],
	.field select {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		font-size: 0.9rem;
		background-color: var(--bg-primary);
		color: var(--text-primary);
		color-scheme: light dark;
	}

	.field input[readonly] {
		opacity: 0.7;
	}

	.hint {
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin: 2px 0 0 0;
	}

	.hint code {
		background: var(--bg-secondary);
		padding: 1px 4px;
		border-radius: 3px;
		font-size: 0.72rem;
	}

	.test-row {
		display: flex;
		align-items: center;
		gap: 12px;
		flex-wrap: wrap;
	}

	.probe-status {
		font-size: 0.82rem;
	}

	.probe-status.detected {
		color: #22c55e;
	}

	.probe-status.error {
		color: var(--error-text);
	}

	.btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.85rem;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.toggle-row {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		cursor: pointer;
	}

	.toggle-row input[type='checkbox'] {
		margin-top: 3px;
		accent-color: var(--accent);
	}

	.toggle-row strong {
		display: block;
		font-size: 0.88rem;
	}

	.toggle-row span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}
</style>
