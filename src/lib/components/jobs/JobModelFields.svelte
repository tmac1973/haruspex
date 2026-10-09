<script lang="ts">
	import { probeInferenceServer, pickProbedModel, probedModelCaps } from '#lib/inferenceProbe.ts';
	import type { NormalizedModel } from '#lib/inferenceProbe.ts';
	import {
		OPENROUTER_BASE_URL,
		fetchOpenRouterCatalog,
		openRouterModelCaps,
		pickOpenRouterModel,
		type OpenRouterModel
	} from '#lib/openrouter.ts';
	import {
		defaultSourceForCaps,
		describeSamplingProfile,
		type SamplingSource
	} from '#lib/agent/jobs/modelAdvanced.ts';
	import {
		isOpenRouterUrl,
		type JobModelForm,
		type ModelSource
	} from '#lib/agent/jobs/jobModelForm.ts';
	import OpenRouterModelPicker from '#lib/components/settings/OpenRouterModelPicker.svelte';
	import ApiKeyPicker from '#lib/components/settings/ApiKeyPicker.svelte';
	import ModeSelector from '#lib/components/ModeSelector.svelte';
	import { getSettings } from '#lib/stores/settings.ts';
	import { KNOWN_EFFORT_LEVELS, resolveBackendDescriptor } from '#lib/inference/descriptor.ts';

	// Where a job's model calls go, and how it behaves: the server, model,
	// context and vision, plus reasoning and sampling. Used for a job's own
	// model (JobEditor) and for each stage of a chain (guided planning).
	let {
		form = $bindable(),
		name,
		allowSettings = true,
		settingsLabel,
		showAdvanced = true
	}: {
		form: JobModelForm;
		/** The source radio group's name; unique per instance on a page. */
		name: string;
		/** Offer "Settings model". */
		allowSettings?: boolean;
		/** The Settings option's wording, when "(default)" would be wrong. */
		settingsLabel?: { title: string; description: string };
		/** Show the reasoning and sampling section; off where the caller can't honour it. */
		showAdvanced?: boolean;
	} = $props();

	// Transient: what the last probe or catalog load found. Never saved.
	let probedModels = $state<NormalizedModel[]>([]);
	let probing = $state(false);
	let probeError = $state<string | null>(null);
	let probeNote = $state<string | null>(null);
	// Seeded from the Settings cache so the picker has data immediately when
	// the user already loaded models there.
	let orCatalog = $state<OpenRouterModel[] | null>(
		form.source === 'openrouter' ? (getSettings().inferenceBackend.openrouterCatalog ?? null) : null
	);
	let orLoading = $state(false);
	let orError = $state<string | null>(null);

	const sourceOptions = $derived(
		(
			[
				{
					value: 'settings',
					title: settingsLabel?.title ?? 'Settings model (default)',
					description:
						settingsLabel?.description ??
						'Uses whatever backend Settings has active (local or remote).'
				},
				{
					value: 'remote',
					title: 'Remote server',
					description: 'A specific OpenAI-compatible server.'
				},
				{
					value: 'openrouter',
					title: 'OpenRouter (cloud)',
					description: 'A specific OpenRouter model — prompts leave your device.'
				}
			] satisfies { value: ModelSource; title: string; description: string }[]
		).filter((o) => allowSettings || o.value !== 'settings')
	);

	// Servers saved in Settings, plus the active one even if it was never
	// added to the list, plus this form's own URL, so a saved job shows it
	// even after it was removed from Settings. OpenRouter has its own source.
	const serverUrlOptions = $derived.by(() => {
		const inf = getSettings().inferenceBackend;
		const saved = inf.remoteServerUrls ?? [];
		const all =
			inf.remoteBaseUrl && !saved.includes(inf.remoteBaseUrl)
				? [...saved, inf.remoteBaseUrl]
				: saved;
		return [...new Set([...all, ...(form.baseUrl ? [form.baseUrl] : [])])]
			.filter(Boolean)
			.filter((u) => !isOpenRouterUrl(u));
	});
	// The probed models, plus the selected id, so a saved model shows before a re-probe.
	const modelIdOptions = $derived(
		[
			...new Set([...probedModels.map((m) => m.id), ...(form.modelId ? [form.modelId] : [])])
		].filter(Boolean)
	);

	// "Inherit" is only meaningful if you can see what it inherits.
	const globalThinkingLabel = $derived(getSettings().thinkingEnabled ? 'on' : 'off');

	// Resolved through the same descriptor the runner uses, so the editor can't
	// promise a tuning or an effort level that won't be applied.
	const backendOverride = $derived(
		form.source !== 'settings' && form.baseUrl.trim()
			? {
					baseUrl: form.baseUrl.trim(),
					modelId: form.modelId.trim() || undefined,
					discovered: form.discovered ?? undefined
				}
			: undefined
	);
	const samplingFamily = $derived(resolveBackendDescriptor(backendOverride).samplingFamily);
	const effortCaps = $derived(resolveBackendDescriptor(backendOverride).reasoningEffort);
	const effortOptions = $derived.by(() => {
		const levels = effortCaps?.levels ?? KNOWN_EFFORT_LEVELS;
		return form.effort && !levels.includes(form.effort) ? [...levels, form.effort] : levels;
	});
	const effortApplies = $derived(
		!form.effort || (effortCaps?.levels.includes(form.effort) ?? false)
	);
	const profileExplanation = $derived(
		describeSamplingProfile(samplingFamily, !!form.discovered?.sampling)
	);

	// Warn when the reasoning control can't reach this server: silently
	// offering a switch that does nothing is how that bug once went unnoticed
	// for a whole overnight run.
	const reasoningCapsNote = $derived.by(() => {
		const caps = form.discovered?.reasoning;
		if (caps?.supported && caps.toggle === 'reasoning_effort' && !effortCaps) {
			return "This server reports a reasoning_effort control but doesn't say which levels it accepts, so effort can't be set from here.";
		}
		if (form.reasoning === 'inherit') return null;
		if (caps && caps.supported && caps.toggle !== 'chat_template_kwargs') {
			return `This server reports its reasoning toggle as "${caps.toggle}", which this app can't set. The choice above will not reach the model — configure it server-side.`;
		}
		if (caps && !caps.supported) {
			return 'The last probe reported that this model has no reasoning mode to toggle.';
		}
		return null;
	});

	function onServerUrlChange(url: string) {
		form.baseUrl = url;
		probedModels = [];
		probeError = null;
		probeNote = null;
	}

	/** Adopt what the probe reported about the picked model. */
	function onModelChange(id: string) {
		form.modelId = id;
		const picked = probedModels.find((x) => x.id === id);
		const caps = probedModelCaps(picked);
		if (caps.contextSize !== null) form.contextSize = caps.contextSize;
		if (caps.vision !== null) form.vision = caps.vision ? 'yes' : 'no';
		// Caps are per model: re-picking replaces them.
		form.discovered = picked
			? { reasoning: picked.reasoning ?? null, sampling: picked.sampling ?? null }
			: null;
		if (!form.sourceTouched) form.samplingSource = defaultSourceForCaps(form.discovered);
	}

	async function probeModel() {
		if (!form.baseUrl.trim()) {
			probeError = 'Pick or enter a server URL first.';
			return;
		}
		probing = true;
		probeError = null;
		probeNote = null;
		try {
			const result = await probeInferenceServer(
				form.baseUrl.trim(),
				form.apiKeyId,
				form.apiKey.trim()
			);
			form.baseUrl = result.base_url;
			probedModels = result.models;
			const pick = pickProbedModel(result.models, form.modelId);
			if (pick) onModelChange(pick.id);
			// llama-server reports one n_ctx for all its models.
			if (
				!(typeof form.contextSize === 'number' && form.contextSize > 0) &&
				typeof result.default_context_size === 'number' &&
				result.default_context_size > 0
			) {
				form.contextSize = result.default_context_size;
			}
			const n = result.models.length;
			probeNote =
				`Found ${n} model${n === 1 ? '' : 's'}` +
				(typeof form.contextSize === 'number'
					? `, ${form.contextSize.toLocaleString()}-token context.`
					: '. No context size reported — enter it manually.');
		} catch (e) {
			probeError = String(e);
		} finally {
			probing = false;
		}
	}

	function setSource(next: ModelSource) {
		if (next === form.source) return;
		if (next === 'openrouter') {
			form.baseUrl = OPENROUTER_BASE_URL;
			orCatalog = getSettings().inferenceBackend.openrouterCatalog ?? null;
			orError = null;
			probedModels = [];
			probeError = null;
			probeNote = null;
		} else if (form.source === 'openrouter') {
			if (form.baseUrl === OPENROUTER_BASE_URL) form.baseUrl = '';
			orCatalog = null;
			orError = null;
		}
		form.source = next;
	}

	async function loadOpenRouterModels() {
		orLoading = true;
		orError = null;
		try {
			const models = await fetchOpenRouterCatalog();
			orCatalog = models;
			const pick = pickOpenRouterModel(models, form.modelId);
			// A still-valid selection keeps the user's manual context/vision edits.
			if (pick !== form.modelId) onOpenRouterModelSelect(pick);
		} catch (e) {
			orError = String(e);
		} finally {
			orLoading = false;
		}
	}

	function onOpenRouterModelSelect(id: string) {
		form.modelId = id;
		const m = orCatalog?.find((x) => x.id === id);
		if (!m) return;
		const caps = openRouterModelCaps(m);
		if (caps.contextSize !== null) form.contextSize = caps.contextSize;
		form.vision = caps.vision ? 'yes' : 'no';
	}
</script>

<ModeSelector {name} value={form.source} onchange={setSource} options={sourceOptions} />
{#if form.source !== 'settings'}
	<div class="model-fields">
		{#if form.source === 'openrouter'}
			<div class="model-row">
				<label class="model-field grow">
					<span class="sublabel">API key</span>
					<ApiKeyPicker selectedId={form.apiKeyId} onSelect={(id) => (form.apiKeyId = id)} />
				</label>
				<button
					type="button"
					class="btn probe-btn"
					disabled={orLoading}
					title="Fetch the OpenRouter model catalog."
					onclick={loadOpenRouterModels}>{orLoading ? 'Loading…' : 'Load models'}</button
				>
			</div>
			{#if orCatalog}
				<div class="model-row">
					<!-- A div, not a label: a label forwards every click inside it to the
					     picker's trigger button, which re-opened the list after a pick. -->
					<div class="model-field grow">
						<span class="sublabel">Model</span>
						<OpenRouterModelPicker
							models={orCatalog}
							selectedId={form.modelId}
							onSelect={onOpenRouterModelSelect}
							toolsOnly={false}
						/>
					</div>
				</div>
			{/if}
			{#if orError}
				<span class="probe-status error-text">{orError}</span>
			{/if}
		{:else}
			<div class="model-row">
				<label class="model-field grow">
					<span class="sublabel">Server URL</span>
					<select value={form.baseUrl} onchange={(e) => onServerUrlChange(e.currentTarget.value)}>
						{#if serverUrlOptions.length === 0}
							<option value="" disabled selected>No servers saved — add one in Settings</option>
						{:else}
							<option value="" disabled>Select a server…</option>
							{#each serverUrlOptions as url (url)}
								<option value={url}>{url}</option>
							{/each}
						{/if}
					</select>
				</label>
				<button
					type="button"
					class="btn probe-btn"
					disabled={probing || !form.baseUrl}
					title="Connect to the selected server to list its models and detect context size + vision."
					onclick={probeModel}>{probing ? 'Probing…' : 'Probe'}</button
				>
			</div>
			<div class="model-row">
				<label class="model-field grow">
					<span class="sublabel">Model</span>
					<select
						value={form.modelId}
						disabled={modelIdOptions.length === 0}
						onchange={(e) => onModelChange(e.currentTarget.value)}
					>
						{#if modelIdOptions.length === 0}
							<option value="" disabled selected>Probe the server to list models</option>
						{:else}
							{#each modelIdOptions as id (id)}
								<option value={id}>{id}</option>
							{/each}
						{/if}
					</select>
				</label>
				<label class="model-field grow">
					<span class="sublabel">API key <span class="optional">(optional)</span></span>
					<ApiKeyPicker selectedId={form.apiKeyId} onSelect={(id) => (form.apiKeyId = id)} />
				</label>
			</div>
			{#if probeError}
				<span class="probe-status error-text">Probe failed: {probeError}</span>
			{:else if probeNote}
				<span class="probe-status">{probeNote}</span>
			{/if}
		{/if}

		<div class="model-row">
			<label
				class="model-field grow"
				title="Context window of the remote model, in tokens. Used for prompt-budget and compaction math. Remote models are often far larger than the local default — Probe auto-fills this."
			>
				<span class="sublabel">Context size (tokens)</span>
				<input
					type="number"
					min="1"
					step="1024"
					bind:value={form.contextSize}
					placeholder="e.g. 131072 — blank = use Settings size"
				/>
			</label>
			<label
				class="model-field"
				title="Whether this model accepts image input. 'From probe / Settings' inherits the global capability; override it if the probe can't tell."
			>
				<span class="sublabel">Vision</span>
				<select bind:value={form.vision}>
					<option value="auto">From probe / Settings</option>
					<option value="yes">Supported</option>
					<option value="no">Not supported</option>
				</select>
			</label>
		</div>
	</div>
{/if}

<!-- Outside the override-only fields on purpose: a job running on the
     Settings backend still wants its own reasoning choice. -->
{#if showAdvanced}
	<details class="advanced">
		<summary>Advanced model behavior</summary>
		<div class="advanced-body">
			<label class="model-field">
				<span class="sublabel">Reasoning</span>
				<select bind:value={form.reasoning}>
					<option value="inherit">Inherit global setting (currently {globalThinkingLabel})</option>
					<option value="on">Always on</option>
					<option value="off">Always off</option>
				</select>
				<span class="adv-hint">
					Reasoning models can spend most of a run thinking. Forcing it off here affects this job
					only.
				</span>
			</label>

			<label class="model-field">
				<span class="sublabel">Reasoning effort</span>
				<select
					value={form.effort ?? ''}
					onchange={(e) => (form.effort = e.currentTarget.value || null)}
					disabled={form.reasoning === 'off'}
				>
					<option value=""
						>Inherit global setting{effortCaps?.modelDefault
							? ` (model default: ${effortCaps.modelDefault})`
							: ''}</option
					>
					{#each effortOptions as level (level)}
						<option value={level}>{level}</option>
					{/each}
				</select>
				<span class="adv-hint">
					How hard the model thinks when reasoning is on. Lower levels tell it up front to keep the
					chain short, rather than cutting it off part-way.
					{#if !effortCaps}
						This job's model publishes no effort levels, so the choice is stored but not sent to it.
					{:else if !effortApplies}
						This job's model accepts only {effortCaps.levels.join(', ')}, so it will use its own
						default until you pick one of those.
					{/if}
				</span>
			</label>

			{#if reasoningCapsNote}
				<p class="adv-note">{reasoningCapsNote}</p>
			{/if}

			<label class="model-field">
				<span class="sublabel">Sampling parameters</span>
				<select
					value={form.samplingSource}
					onchange={(e) => {
						form.samplingSource = e.currentTarget.value as SamplingSource;
						form.sourceTouched = true;
					}}
				>
					<option value="server">Server defaults — send nothing</option>
					<option value="profile">App-tuned profile</option>
					<option value="custom">Custom</option>
				</select>
				<span class="adv-hint">
					{#if form.samplingSource === 'server'}
						No sampling fields are sent, so whatever the server is configured with stands.
					{:else if form.samplingSource === 'profile'}
						{profileExplanation}
					{:else}
						Exactly the values below. Leave a field blank to omit it.
					{/if}
				</span>
			</label>

			{#if form.samplingSource === 'custom'}
				<div class="model-row wrap">
					<label class="model-field">
						<span class="sublabel">Temperature</span>
						<input type="number" step="0.05" min="0" bind:value={form.temperature} />
					</label>
					<label class="model-field">
						<span class="sublabel">top_p</span>
						<input type="number" step="0.05" min="0" max="1" bind:value={form.topP} />
					</label>
					<label class="model-field">
						<span class="sublabel">top_k</span>
						<input type="number" step="1" min="0" bind:value={form.topK} />
					</label>
					<label class="model-field">
						<span class="sublabel">min_p</span>
						<input type="number" step="0.01" min="0" max="1" bind:value={form.minP} />
					</label>
					<label class="model-field">
						<span class="sublabel">presence_penalty</span>
						<input type="number" step="0.1" bind:value={form.presencePenalty} />
					</label>
				</div>
				{#if form.source === 'openrouter'}
					<p class="adv-note">
						OpenRouter ignores top_k and min_p — they are dropped from the request rather than
						risking a 400 from a stricter upstream provider.
					</p>
				{/if}
			{/if}
		</div>
	</details>
{/if}

<style>
	.optional {
		font-weight: normal;
		opacity: 0.7;
	}

	.model-fields {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin-top: 8px;
	}

	.model-row {
		display: flex;
		gap: 8px;
		align-items: flex-end;
	}

	.model-field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.model-field.grow {
		flex: 1;
		min-width: 0;
	}

	.model-row.wrap {
		flex-wrap: wrap;
	}

	.model-row.wrap .model-field {
		flex: 1 1 120px;
		min-width: 0;
	}

	.advanced {
		margin-top: 10px;
		border-top: 1px solid var(--border);
		padding-top: 8px;
	}

	.advanced summary {
		cursor: pointer;
		user-select: none;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.advanced-body {
		display: flex;
		flex-direction: column;
		gap: 10px;
		margin-top: 8px;
	}

	.adv-hint {
		font-size: 0.72rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.adv-note {
		margin: 0;
		padding: 6px 8px;
		border: 1px solid color-mix(in srgb, var(--warning) 40%, var(--border));
		background: color-mix(in srgb, var(--warning) 12%, transparent);
		border-radius: 4px;
		font-size: 0.74rem;
		line-height: 1.35;
	}

	.sublabel {
		font-size: 0.72rem;
		color: var(--text-secondary);
	}

	.probe-btn {
		flex-shrink: 0;
		white-space: nowrap;
	}

	.probe-status {
		font-size: 0.74rem;
		color: var(--text-secondary);
	}
</style>
