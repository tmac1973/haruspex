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
	import { getApiKeyValue } from '$lib/stores/settings';
	import { pickProbedModel, type NormalizedModel, type ProbeResult } from '$lib/inferenceProbe';
	import ApiKeyPicker from '$lib/components/settings/ApiKeyPicker.svelte';

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
	// Saved server URLs the user can switch between. Seed from the active
	// URL so upgrading users (who only ever had a single `remoteBaseUrl`)
	// see it in the dropdown straight away and can add more alongside it.
	let serverUrls = $state<string[]>(
		untrack(() => {
			const saved = config.remoteServerUrls ?? [];
			if (config.remoteBaseUrl && !saved.includes(config.remoteBaseUrl)) {
				return [...saved, config.remoteBaseUrl];
			}
			return [...saved];
		})
	);
	let apiKey = $state(untrack(() => config.remoteApiKey));
	let apiKeyId = $state<string | null>(untrack(() => config.remoteApiKeyId ?? null));
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

	// True when a URL points at openrouter.ai — filtered out of the generic
	// remote server dropdown so OpenRouter isn't reachable from two places.
	function isOpenRouterUrl(url: string): boolean {
		try {
			return new URL(url).hostname === 'openrouter.ai';
		} catch {
			return false;
		}
	}

	// Options shown in the Server URL dropdown. OpenRouter URLs are hidden
	// (they have a dedicated backend option in InferenceSection). If the user
	// has typed/edited a URL that isn't saved yet, surface it as the
	// (selected) first option so the dropdown always reflects the active
	// `baseUrl` — otherwise a `<select>` whose value matches no <option>
	// renders blank.
	let urlOptions = $derived(
		baseUrl && !serverUrls.includes(baseUrl)
			? [baseUrl, ...serverUrls.filter((u) => !isOpenRouterUrl(u))]
			: serverUrls.filter((u) => !isOpenRouterUrl(u))
	);

	function commit(partial: Partial<InferenceBackendConfig>) {
		onConfigChange({ ...config, ...partial });
	}

	// Per-model capability fields to persist alongside a probe / model
	// switch. Sampling + reasoning are only ever populated by llama-toolchest;
	// for other backends they're null, which also correctly clears any stale
	// toolchest caps when the user re-probes a different server. The parallel
	// slot count auto-sets the parallel-inference toggle — but only for
	// toolchest, since other backends don't report it and we must not clobber
	// the user's manual choice.
	function capabilityCommit(
		m: NormalizedModel | undefined,
		kind: InferenceBackendKind
	): Partial<InferenceBackendConfig> {
		const partial: Partial<InferenceBackendConfig> = {
			remoteSampling: m?.sampling ?? null,
			remoteReasoning: m?.reasoning ?? null,
			remoteParallel: m?.parallel ?? null
		};
		if (kind === 'llama-toolchest' && typeof m?.parallel === 'number') {
			partial.allowParallelInference = m.parallel > 1;
		}
		return partial;
	}

	// --- "Detected capabilities" readout (llama-toolchest only) ----------
	// Driven off the persisted `config` so it survives a settings reload, not
	// just the moment after a probe.
	let showCaps = $derived(
		config.remoteBackendKind === 'llama-toolchest' &&
			(config.remoteReasoning !== null || config.remoteSampling !== null)
	);

	function reasoningSummary(r: InferenceBackendConfig['remoteReasoning']): string {
		if (!r) return 'unknown';
		if (!r.supported) return 'not supported';
		if (r.toggle === 'chat_template_kwargs' && r.kwarg) {
			return `${r.kwarg} · ${r.default_enabled ? 'on' : 'off'} by default`;
		}
		return r.toggle;
	}

	function samplingSummary(s: InferenceBackendConfig['remoteSampling']): string {
		if (!s) return 'not reported';
		const label = s.source === 'readme' ? 'README recommendation' : (s.source ?? 'recommended');
		const n = s.presets.length;
		return `${label} · ${n} preset${n === 1 ? '' : 's'}`;
	}

	function selectUrl(url: string) {
		baseUrl = url;
		// Switching servers invalidates the previous probe's result.
		probeResult = null;
		probeError = null;
		commit({ remoteBaseUrl: url });
	}

	function addUrl() {
		const url = baseUrl.trim();
		if (!url || serverUrls.includes(url)) return;
		serverUrls = [...serverUrls, url];
		baseUrl = url;
		commit({ remoteBaseUrl: url, remoteServerUrls: serverUrls });
	}

	function removeUrl() {
		const next = serverUrls.filter((u) => u !== baseUrl);
		serverUrls = next;
		// Fall back to the first remaining saved URL (or blank) as the new
		// active server.
		const replacement = next[0] ?? '';
		baseUrl = replacement;
		probeResult = null;
		probeError = null;
		commit({ remoteBaseUrl: replacement, remoteServerUrls: next });
	}

	async function testConnection() {
		probing = true;
		probeError = null;
		try {
			const resolvedKey = getApiKeyValue(apiKeyId) ?? apiKey;
			const result = await invoke<ProbeResult>('probe_inference_server', {
				baseUrl,
				apiKey: resolvedKey || null
			});
			probeResult = result;
			// Commit the normalized URL (the Rust side may have stripped
			// a trailing slash or /v1 suffix), and pick a sensible default
			// model: prefer the current selection if it's still in the
			// list, otherwise take the first loaded model, otherwise the
			// first model overall.
			const pick = pickProbedModel(result.models, modelId);
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
				remoteApiKeyId: apiKeyId,
				remoteModelId: modelId,
				remoteContextSize: typeof manualContextSize === 'number' ? manualContextSize : null,
				remoteVisionSupported: visionOverride,
				remoteBackendKind: result.kind,
				...capabilityCommit(selectedModel, result.kind)
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
			remoteVisionSupported: visionOverride,
			...capabilityCommit(m, probeResult?.kind ?? null)
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
		{#if serverUrls.length > 0}
			<div class="url-row">
				<select
					class="url-select"
					aria-label="Saved server URLs"
					value={baseUrl}
					onchange={(e) => selectUrl((e.target as HTMLSelectElement).value)}
				>
					{#each urlOptions as url (url)}
						<option value={url}>{url}</option>
					{/each}
				</select>
				<button
					class="btn"
					type="button"
					onclick={removeUrl}
					disabled={!serverUrls.includes(baseUrl)}
				>
					Remove
				</button>
			</div>
		{/if}
		<div class="url-row">
			<input
				id="inf-base-url"
				type="text"
				placeholder="http://localhost:8080"
				bind:value={baseUrl}
				onblur={() => commit({ remoteBaseUrl: baseUrl })}
			/>
			<button
				class="btn"
				type="button"
				onclick={addUrl}
				disabled={!baseUrl.trim() || serverUrls.includes(baseUrl.trim())}
			>
				Add
			</button>
		</div>
		<p class="hint">
			The base URL of your inference server. Examples:
			<code>http://localhost:11434</code> (Ollama),
			<code>http://localhost:1234</code> (LM Studio),
			<code>http://10.0.0.5:8080</code> (llama-server or llama-toolchest).
		</p>
	</div>

	<div class="field">
		<label for="inf-api-key">API Key</label>
		<ApiKeyPicker
			selectedId={apiKeyId}
			onSelect={(id) => {
				apiKeyId = id;
				commit({ remoteApiKeyId: id });
			}}
		/>
		<p class="hint">
			Only needed for servers that require authentication. Sent as
			<code>Authorization: Bearer …</code>. Managed in the API Keys section below.
		</p>
	</div>

	<div class="test-row">
		<button class="btn btn-primary" onclick={testConnection} disabled={probing || !baseUrl}>
			{probing ? 'Probing…' : 'Probe connection'}
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

		<div class="field">
			<label class="toggle-row">
				<input
					type="checkbox"
					checked={config.allowParallelInference}
					onchange={(e) =>
						commit({ allowParallelInference: (e.target as HTMLInputElement).checked })}
				/>
				<div>
					<strong>Allow parallel inference</strong>
					<span>
						Skip the app's request queue and let chat + job turns run concurrently against this
						server. Only enable if the server supports concurrent requests — e.g. vLLM, llama-server
						launched with <code>-np N</code>, or hosted APIs. For single-slot servers leave this off
						so a queued turn shows a "waiting" indicator instead of silently blocking.
					</span>
				</div>
			</label>
		</div>
	{/if}

	{#if showCaps}
		<div class="caps">
			<div class="caps-title">Detected capabilities <span>llama-toolchest</span></div>
			<dl class="caps-grid">
				{#if config.remoteReasoning}
					<dt>Reasoning</dt>
					<dd>{reasoningSummary(config.remoteReasoning)}</dd>
				{/if}
				{#if config.remoteSampling}
					<dt>Sampling</dt>
					<dd>{samplingSummary(config.remoteSampling)}</dd>
				{/if}
				{#if config.remoteParallel !== null}
					<dt>Parallel</dt>
					<dd>{config.remoteParallel} slot{config.remoteParallel === 1 ? '' : 's'}</dd>
				{/if}
				{#if config.remoteContextSize !== null}
					<dt>Context</dt>
					<dd>{config.remoteContextSize.toLocaleString()} tokens / request</dd>
				{/if}
				{#if config.remoteVisionSupported !== null}
					<dt>Vision</dt>
					<dd>{config.remoteVisionSupported ? 'supported' : 'not supported'}</dd>
				{/if}
			</dl>
			<p class="hint">
				Discovered from the server and applied automatically — sampling and reasoning come from the
				model's recommendations, not Haruspex's built-in defaults.
			</p>
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

	.caps {
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 12px 14px;
		background: var(--bg-secondary);
	}

	.caps-title {
		font-size: 0.85rem;
		font-weight: 600;
		margin-bottom: 8px;
	}

	.caps-title span {
		font-size: 0.68rem;
		font-weight: 500;
		text-transform: uppercase;
		letter-spacing: 0.03em;
		color: var(--text-secondary);
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 1px 6px;
		margin-left: 6px;
		vertical-align: middle;
	}

	.caps-grid {
		display: grid;
		grid-template-columns: max-content 1fr;
		gap: 4px 16px;
		margin: 0;
	}

	.caps-grid dt {
		font-size: 0.8rem;
		color: var(--text-secondary);
	}

	.caps-grid dd {
		font-size: 0.8rem;
		margin: 0;
		font-variant-numeric: tabular-nums;
	}

	.caps .hint {
		margin-top: 10px;
	}

	.url-row {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	.url-row input[type='text'],
	.url-row .url-select {
		flex: 1;
		min-width: 0;
	}

	.url-row .btn {
		flex-shrink: 0;
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
