<script lang="ts">
	/**
	 * Dedicated settings form for the OpenRouter cloud backend. Unlike the
	 * generic InferenceBackendForm (which probes via Rust), this fetches the
	 * OpenRouter model catalog directly from `GET /api/v1/models` and the key
	 * status from `GET /api/v1/key` — both plain `fetch()` since OpenRouter is
	 * CORS-open and the Rust probe would 404/429 against it.
	 */
	import { untrack } from 'svelte';
	import type { InferenceBackendConfig } from '$lib/stores/settings';
	import { getApiKeyValue } from '$lib/stores/settings';
	import {
		fetchOpenRouterCatalog,
		fetchOpenRouterKeyStatus,
		OPENROUTER_CATALOG_TTL_MS,
		FREE_MODEL_RPM,
		FREE_MODEL_NO_CREDITS_RPD,
		FREE_MODEL_HAS_CREDITS_RPD,
		isOpenRouterVisionCapable,
		type OpenRouterModel,
		type OpenRouterKeyStatus
	} from '$lib/openrouter';
	import OpenRouterModelPicker from '$lib/components/settings/OpenRouterModelPicker.svelte';
	import ApiKeyPicker from '$lib/components/settings/ApiKeyPicker.svelte';

	interface Props {
		config: InferenceBackendConfig;
		onConfigChange: (next: InferenceBackendConfig) => void;
	}

	let { config, onConfigChange }: Props = $props();

	let apiKeyId = $state<string | null>(untrack(() => config.remoteApiKeyId ?? null));
	let modelId = $state(untrack(() => config.remoteModelId));
	let catalog = $state<OpenRouterModel[] | null>(untrack(() => config.openrouterCatalog));
	let keyStatus = $state<OpenRouterKeyStatus | null>(untrack(() => config.openrouterKeyStatus));
	let loading = $state(false);
	let keyLoading = $state(false);
	let error = $state<string | null>(null);
	let toolsOnly = $state(false);

	const catalogStale = $derived(
		!catalog ||
			!config.openrouterCatalogAt ||
			Date.now() - config.openrouterCatalogAt > OPENROUTER_CATALOG_TTL_MS
	);

	const selectedModel = $derived(catalog?.find((m) => m.id === modelId) ?? null);

	function commit(partial: Partial<InferenceBackendConfig>) {
		onConfigChange({ ...config, ...partial });
	}

	async function loadCatalog(force = false) {
		if (!force && !catalogStale) return;
		loading = true;
		error = null;
		try {
			const models = await fetchOpenRouterCatalog();
			catalog = models;
			// Default to openrouter/auto on first load, or keep the last-used model.
			if (!modelId || !models.some((m) => m.id === modelId)) {
				const auto = models.find((m) => m.id === 'openrouter/auto');
				modelId = auto ? auto.id : (models[0]?.id ?? '');
			}
			commit({
				openrouterCatalog: models,
				openrouterCatalogAt: Date.now(),
				remoteModelId: modelId,
				...autoModelFields(models.find((m) => m.id === modelId))
			});
		} catch (e) {
			error = String(e);
		} finally {
			loading = false;
		}
	}

	function autoModelFields(m: OpenRouterModel | undefined): Partial<InferenceBackendConfig> {
		if (!m) return {};
		const partial: Partial<InferenceBackendConfig> = {
			remoteContextSize: m.context_length,
			remoteVisionSupported: isOpenRouterVisionCapable(m)
		};
		if (m.reasoning) {
			partial.openrouterReasoningEffort = m.reasoning.default_effort;
		} else {
			partial.openrouterReasoningEffort = null;
		}
		return partial;
	}

	async function testKey() {
		const resolvedKey = getApiKeyValue(apiKeyId);
		if (!resolvedKey) {
			error = 'Select an API key first.';
			return;
		}
		keyLoading = true;
		error = null;
		try {
			const status = await fetchOpenRouterKeyStatus(resolvedKey);
			keyStatus = status;
			commit({
				remoteApiKeyId: apiKeyId,
				openrouterKeyStatus: status,
				openrouterKeyStatusAt: Date.now()
			});
		} catch (e) {
			error = String(e);
		} finally {
			keyLoading = false;
		}
	}

	function onModelSelect(id: string) {
		modelId = id;
		const m = catalog?.find((x) => x.id === id);
		commit({ remoteModelId: id, ...autoModelFields(m) });
	}

	function onContextChange(val: string) {
		const parsed = parseInt(val, 10);
		if (!Number.isNaN(parsed) && parsed > 0) {
			commit({ remoteContextSize: parsed });
		}
	}

	function onVisionToggle(val: boolean) {
		commit({ remoteVisionSupported: val });
	}

	function onEffortChange(effort: string) {
		commit({ openrouterReasoningEffort: effort });
	}

	function onApiKeySelect(id: string | null) {
		apiKeyId = id;
		commit({ remoteApiKeyId: id });
	}

	function onParallelToggle(val: boolean) {
		commit({ allowParallelInference: val });
	}

	const freeDailyLimit = $derived(
		keyStatus?.is_free_tier ? FREE_MODEL_NO_CREDITS_RPD : FREE_MODEL_HAS_CREDITS_RPD
	);
</script>

<div class="or-form">
	<p class="privacy-warning">
		<strong>Cloud backend.</strong> Your prompts and the model's responses leave your device and go to
		OpenRouter's servers. This is different from the local and self-hosted remote modes where everything
		stays on your machine.
	</p>

	<div class="field">
		<label for="or-api-key">API Key</label>
		<ApiKeyPicker selectedId={apiKeyId} onSelect={onApiKeySelect} />
		<div class="hint-row">
			<p class="hint">
				Create a key at
				<a href="https://openrouter.ai/keys" target="_blank" rel="noopener">openrouter.ai/keys</a>.
				Managed in the API Keys section below.
			</p>
			<button class="btn btn-small" onclick={testKey} disabled={keyLoading || !apiKeyId}>
				{keyLoading ? 'Checking…' : 'Test key'}
			</button>
		</div>
	</div>

	{#if keyStatus}
		<div class="credits-badge">
			{#if keyStatus.limit !== null}
				<span>Credits remaining: {keyStatus.limit_remaining ?? '?'}/{keyStatus.limit}</span>
			{:else}
				<span>Credits used: ${keyStatus.usage_monthly.toFixed(2)} this month</span>
			{/if}
			{#if keyStatus.is_free_tier}
				<span class="free-tier">
					Free tier — {FREE_MODEL_RPM} RPM, {freeDailyLimit} RPD for <code>:free</code> models.
				</span>
			{/if}
		</div>
	{/if}

	<div class="field">
		<label for="or-model">Model</label>
		<div class="model-row">
			{#if catalog}
				<OpenRouterModelPicker
					models={catalog}
					selectedId={modelId}
					onSelect={onModelSelect}
					{toolsOnly}
				/>
			{:else}
				<p class="hint">Load the catalog to pick a model.</p>
			{/if}
			<button class="btn btn-small" onclick={() => loadCatalog(true)} disabled={loading}>
				{loading ? 'Loading…' : catalog ? 'Refresh' : 'Load models'}
			</button>
		</div>
		<label class="toggle-row small">
			<input type="checkbox" bind:checked={toolsOnly} />
			<span>Only show models that support tool calling (needed for the agent loop)</span>
		</label>
	</div>

	{#if selectedModel?.reasoning}
		<div class="field">
			<label for="or-effort">Reasoning effort</label>
			<select
				id="or-effort"
				value={config.openrouterReasoningEffort ?? selectedModel.reasoning.default_effort}
				onchange={(e) => onEffortChange((e.target as HTMLSelectElement).value)}
				disabled={selectedModel.reasoning.mandatory}
			>
				{#each selectedModel.reasoning.supported_efforts as effort (effort)}
					<option value={effort}>{effort}</option>
				{/each}
			</select>
			<p class="hint">
				{#if selectedModel.reasoning.mandatory}
					This model always reasons — effort is locked.
				{:else}
					Controls how many tokens the model spends on internal reasoning before answering.
				{/if}
			</p>
		</div>
	{/if}

	<div class="field">
		<label for="or-ctx">Context size (tokens)</label>
		<input
			id="or-ctx"
			type="number"
			min="512"
			step="512"
			placeholder="e.g. 128000"
			value={config.remoteContextSize ?? selectedModel?.context_length ?? ''}
			oninput={(e) => onContextChange((e.target as HTMLInputElement).value)}
		/>
		<p class="hint">
			Auto-filled from the model card. Haruspex uses this to decide when to compact long
			conversations.
		</p>
	</div>

	<div class="field">
		<label class="toggle-row">
			<input
				type="checkbox"
				checked={config.remoteVisionSupported === true}
				onchange={(e) => onVisionToggle((e.target as HTMLInputElement).checked)}
			/>
			<div>
				<strong>This model supports vision (image input)</strong>
				<span>
					{#if selectedModel && isOpenRouterVisionCapable(selectedModel)}
						Detected from the model's input modalities.
					{:else}
						Auto-detected; override only if you know the model is multimodal.
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
				onchange={(e) => onParallelToggle((e.target as HTMLInputElement).checked)}
			/>
			<div>
				<strong>Allow parallel inference</strong>
				<span>
					OpenRouter is a hosted API and handles concurrent requests. On by default; turn off only
					if you want chat and job turns serialized.
				</span>
			</div>
		</label>
	</div>

	{#if error}
		<p class="error">✗ {error}</p>
	{/if}
</div>

<style>
	.or-form {
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.privacy-warning {
		padding: 8px 12px;
		border: 1px solid var(--error-border);
		border-radius: 6px;
		background: color-mix(in srgb, var(--error-bg) 60%, transparent);
		font-size: 0.8rem;
		color: var(--text-primary);
		margin: 0;
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

	.field input[type='number'],
	.field select {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.85rem;
	}

	.hint-row {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.hint {
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin: 0;
	}

	.hint a {
		color: var(--accent);
	}

	.credits-badge {
		padding: 8px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		font-size: 0.8rem;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}

	.free-tier {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.free-tier code {
		font-size: 0.72rem;
	}

	.model-row {
		display: flex;
		gap: 8px;
		align-items: stretch;
	}

	.model-row > :first-child {
		flex: 1;
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
		font-size: 0.85rem;
	}

	.toggle-row span {
		display: block;
		font-size: 0.78rem;
		color: var(--text-secondary);
		margin-top: 2px;
	}

	.toggle-row.small {
		font-size: 0.78rem;
		color: var(--text-secondary);
		align-items: center;
		margin-top: 4px;
	}

	.btn {
		padding: 6px 14px;
		border-radius: 6px;
		font-size: 0.8rem;
		cursor: pointer;
		border: 1px solid var(--border);
		background: var(--bg-secondary);
		color: var(--text-primary);
		flex: none;
	}

	.btn:hover:not(:disabled) {
		opacity: 0.9;
	}

	.btn:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.btn-small {
		padding: 4px 10px;
		font-size: 0.78rem;
	}

	.error {
		padding: 8px 12px;
		border: 1px solid var(--error-border);
		border-radius: 6px;
		background: var(--error-bg);
		color: var(--error-text);
		font-size: 0.8rem;
		margin: 0;
	}
</style>
