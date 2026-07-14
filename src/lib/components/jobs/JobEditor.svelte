<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import {
		pickProbedModel,
		probeInferenceServer,
		probedModelCaps,
		type NormalizedModel
	} from '$lib/inferenceProbe';
	import {
		OPENROUTER_BASE_URL,
		fetchOpenRouterCatalog,
		openRouterModelCaps,
		pickOpenRouterModel,
		type OpenRouterModel
	} from '$lib/openrouter';
	import OpenRouterModelPicker from '$lib/components/settings/OpenRouterModelPicker.svelte';
	import ApiKeyPicker from '$lib/components/settings/ApiKeyPicker.svelte';
	import ModeSelector from '$lib/components/ModeSelector.svelte';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import JobScheduleField from '$lib/components/jobs/JobScheduleField.svelte';
	import {
		createJob,
		updateJob,
		deleteJob,
		getJob,
		replaceJobSteps,
		scheduleToConfigJson,
		configJsonToSchedule,
		computeNextDueAt,
		type Schedule,
		type JobInput,
		type JobStepInput,
		type JobType
	} from '$lib/stores/jobs.svelte';
	import { getSettings } from '$lib/stores/settings';
	import {
		ensureTypeAvailabilityLoaded,
		getJobType,
		isJobTypeAvailable,
		listJobTypes
	} from '$lib/agent/jobs/types';

	// Platform-gated types (autonomous coding) hide from the picker until
	// their probe says otherwise; idempotent, so fire per mount.
	void ensureTypeAvailabilityLoaded();

	interface Props {
		jobId: number | 'new';
		onsaved: (id: number) => void;
		ondeleted: () => void;
		oncancel: () => void;
	}

	const { jobId, onsaved, ondeleted, oncancel }: Props = $props();

	let name = $state('');
	let description = $state('');
	let workingDir = $state('');
	let schedule = $state<Schedule>({ kind: 'manual' });
	let steps = $state<JobStepInput[]>([{ prompt: '', deep_research: false }]);
	let jobType = $state<JobType>('research');
	// The selected type's editor state, owned by its JobTypeDefinition
	// (configDefaults / configFromJob / configToJson). Its Editor component
	// mutates it in place; switching types stashes it so toggling back keeps
	// unsaved edits.
	let typeConfig = $state<Record<string, unknown>>({});
	let typeConfigStash: Partial<Record<JobType, Record<string, unknown>>> = {};

	const typeDef = $derived(getJobType(jobType)!);
	const TypeEditor = $derived(typeDef.Editor);

	function setJobType(next: JobType) {
		if (next === jobType) return;
		typeConfigStash[jobType] = typeConfig;
		jobType = next;
		typeConfig = typeConfigStash[next] ?? getJobType(next)!.configDefaults();
	}
	// Where this job's model calls go (any job type): 'settings' follows the
	// app's active Settings backend; 'remote'/'openrouter' pin the job to a
	// specific server/model configured below. One selection — mirrors the
	// Settings → Inference backend mode picker.
	type ModelSource = 'settings' | 'remote' | 'openrouter';
	let modelSource = $state<ModelSource>('settings');
	let modelBaseUrl = $state('');
	let modelApiKey = $state('');
	let modelApiKeyId = $state<string | null>(null);
	let modelModelId = $state('');
	let modelContextSize = $state<number | ''>('');
	// Tri-state vision capability for the override model: 'auto' inherits the
	// global Settings capability; 'yes'/'no' force it on/off for this job.
	let modelVision = $state<'auto' | 'yes' | 'no'>('auto');
	// Models returned by the last successful probe — populates the Model
	// dropdown and lets a model pick update context/vision (like Settings).
	let probedModels = $state<NormalizedModel[]>([]);
	let probing = $state(false);
	let probeError = $state<string | null>(null);
	let probeNote = $state<string | null>(null);
	// OpenRouter-specific override state. When modelSource is 'openrouter',
	// the form shows a catalog-powered model picker instead of the generic
	// probe flow. The catalog is fetched from OpenRouter's /v1/models (no
	// Rust probe round-trip) and may reuse the cache from Settings.
	let orCatalog = $state<OpenRouterModel[] | null>(null);
	let orLoading = $state(false);
	let orError = $state<string | null>(null);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	$effect(() => {
		loadIntoForm(jobId);
	});

	async function loadIntoForm(id: number | 'new') {
		error = null;
		if (id === 'new') {
			name = '';
			description = '';
			workingDir = '';
			schedule = { kind: 'manual' };
			steps = [{ prompt: '', deep_research: false }];
			jobType = 'research';
			typeConfigStash = {};
			typeConfig = getJobType('research')!.configDefaults();
			modelSource = 'settings';
			modelBaseUrl = '';
			modelApiKey = '';
			modelApiKeyId = null;
			modelModelId = '';
			modelContextSize = '';
			modelVision = 'auto';
			probedModels = [];
			probeError = null;
			probeNote = null;
			orCatalog = null;
			orError = null;
			return;
		}
		loading = true;
		try {
			const job = await getJob(id);
			if (!job) {
				error = 'Could not load job';
				return;
			}
			name = job.name;
			description = job.description ?? '';
			workingDir = job.working_dir;
			schedule = configJsonToSchedule(job.schedule_kind, job.schedule_config) ?? {
				kind: 'manual'
			};
			steps =
				job.steps.length > 0
					? job.steps.map((s) => ({ prompt: s.prompt, deep_research: s.deep_research }))
					: [{ prompt: '', deep_research: false }];
			jobType = job.job_type;
			typeConfigStash = {};
			typeConfig =
				getJobType(job.job_type)?.configFromJob(job.type_config) ?? ({} as Record<string, unknown>);
			modelBaseUrl = job.model_remote_base_url ?? '';
			modelApiKey = job.model_remote_api_key ?? '';
			modelApiKeyId = job.model_remote_api_key_id ?? null;
			modelModelId = job.model_remote_model_id ?? '';
			modelContextSize = job.model_remote_context_size ?? '';
			modelVision =
				job.model_remote_vision_supported == null
					? 'auto'
					: job.model_remote_vision_supported
						? 'yes'
						: 'no';
			// No saved base URL → the job follows Settings; otherwise detect
			// OpenRouter by URL so the right form renders on reload.
			modelSource = !modelBaseUrl
				? 'settings'
				: isOpenRouterUrl(modelBaseUrl)
					? 'openrouter'
					: 'remote';
			// Seed the OpenRouter catalog from the Settings cache so the picker
			// has data immediately if the user already loaded models in Settings.
			if (modelSource === 'openrouter') {
				orCatalog = getSettings().inferenceBackend.openrouterCatalog ?? null;
			}
			probedModels = [];
			probeError = null;
			probeNote = null;
			orError = null;
		} finally {
			loading = false;
		}
	}

	async function pickWorkingDir() {
		try {
			const selected = await open({
				directory: true,
				multiple: false,
				title: 'Select working directory for this job'
			});
			if (typeof selected === 'string') {
				workingDir = selected;
			}
		} catch (e) {
			console.error('Failed to pick directory:', e);
		}
	}

	// Server URLs saved in Settings — the options for the URL dropdown. A job
	// loaded with a URL no longer in Settings still shows it (union below) so
	// editing doesn't silently drop it. OpenRouter URLs are hidden from the
	// generic dropdown (they have a dedicated override type toggle above).
	function isOpenRouterUrl(url: string): boolean {
		try {
			return new URL(url).hostname === 'openrouter.ai';
		} catch {
			return false;
		}
	}

	const savedServerUrls = $derived(getSettings().inferenceBackend.remoteServerUrls ?? []);
	const serverUrlOptions = $derived(
		[...new Set([...savedServerUrls, ...(modelBaseUrl ? [modelBaseUrl] : [])])]
			.filter(Boolean)
			.filter((u) => !isOpenRouterUrl(u))
	);
	// Model dropdown options: the probed models, plus the currently-selected id
	// so a saved job's model shows before you re-probe.
	const modelIdOptions = $derived(
		[
			...new Set([...probedModels.map((m) => m.id), ...(modelModelId ? [modelModelId] : [])])
		].filter(Boolean)
	);

	/** Picking a server URL invalidates the previously-probed model list. */
	function onServerUrlChange(url: string) {
		modelBaseUrl = url;
		probedModels = [];
		probeError = null;
		probeNote = null;
	}

	/** Selecting a model adopts its probed context/vision caps (like Settings). */
	function onModelChange(id: string) {
		modelModelId = id;
		const caps = probedModelCaps(probedModels.find((x) => x.id === id));
		if (caps.contextSize !== null) modelContextSize = caps.contextSize;
		if (caps.vision !== null) modelVision = caps.vision ? 'yes' : 'no';
	}

	/**
	 * Hit the override server to list its models and detect context/vision. The
	 * point of the override is using a different — usually larger-context —
	 * remote model, and the user shouldn't have to know the exact numbers.
	 */
	async function probeModel() {
		if (!modelBaseUrl.trim()) {
			probeError = 'Pick or enter a server URL first.';
			return;
		}
		probing = true;
		probeError = null;
		probeNote = null;
		try {
			const result = await probeInferenceServer(
				modelBaseUrl.trim(),
				modelApiKeyId,
				modelApiKey.trim()
			);
			modelBaseUrl = result.base_url;
			probedModels = result.models;
			const pick = pickProbedModel(result.models, modelModelId);
			if (pick) onModelChange(pick.id);
			// Fall back to the server-level context if the picked model didn't
			// carry its own (llama-server reports one n_ctx for all models).
			if (
				!(typeof modelContextSize === 'number' && modelContextSize > 0) &&
				typeof result.default_context_size === 'number' &&
				result.default_context_size > 0
			) {
				modelContextSize = result.default_context_size;
			}
			const n = result.models.length;
			probeNote =
				`Found ${n} model${n === 1 ? '' : 's'}` +
				(typeof modelContextSize === 'number'
					? `, ${modelContextSize.toLocaleString()}-token context.`
					: '. No context size reported — enter it manually.');
		} catch (e) {
			probeError = String(e);
		} finally {
			probing = false;
		}
	}

	/**
	 * Switch where the job's model calls go. OpenRouter pins the base URL and
	 * seeds the catalog from the Settings cache; leaving it clears that state
	 * so the generic probe flow takes over. Selecting 'settings' keeps the
	 * fields as-is — they're simply not persisted (save() nulls them).
	 */
	function setModelSource(source: ModelSource) {
		if (source === modelSource) return;
		if (source === 'openrouter') {
			modelBaseUrl = OPENROUTER_BASE_URL;
			orCatalog = getSettings().inferenceBackend.openrouterCatalog ?? null;
			orError = null;
			probedModels = [];
			probeError = null;
			probeNote = null;
		} else if (modelSource === 'openrouter') {
			if (modelBaseUrl === OPENROUTER_BASE_URL) modelBaseUrl = '';
			orCatalog = null;
			orError = null;
		}
		modelSource = source;
	}

	/** Fetch the OpenRouter catalog directly (no Rust probe round-trip). */
	async function loadOpenRouterModels() {
		orLoading = true;
		orError = null;
		try {
			const models = await fetchOpenRouterCatalog();
			orCatalog = models;
			const pick = pickOpenRouterModel(models, modelModelId);
			// Only re-adopt when the pick actually changed — a valid current
			// selection keeps the user's manual context/vision edits.
			if (pick !== modelModelId) onOpenRouterModelSelect(pick);
		} catch (e) {
			orError = String(e);
		} finally {
			orLoading = false;
		}
	}

	/** Selecting an OpenRouter model: update context + vision from the card. */
	function onOpenRouterModelSelect(id: string) {
		modelModelId = id;
		const m = orCatalog?.find((x) => x.id === id);
		if (!m) return;
		const caps = openRouterModelCaps(m);
		if (caps.contextSize !== null) modelContextSize = caps.contextSize;
		modelVision = caps.vision ? 'yes' : 'no';
	}

	function validate(): string | null {
		if (!name.trim()) return 'Name is required.';
		return (
			typeDef.validate?.({
				name,
				workingDir,
				steps: $state.snapshot(steps),
				config: $state.snapshot(typeConfig)
			}) ?? null
		);
	}

	/** Default step persistence: prompts trimmed, empties dropped. */
	function defaultPersistSteps(all: JobStepInput[]): JobStepInput[] {
		return all
			.map((s) => ({ prompt: s.prompt.trim(), deep_research: s.deep_research }))
			.filter((s) => s.prompt.length > 0);
	}

	async function save() {
		const v = validate();
		if (v) {
			error = v;
			// The offending field may be inside a folded section — unfold
			// everything so the error is visible and fixable.
			openSections = { basics: true, where: true, model: true, type: true };
			return;
		}
		error = null;
		saving = true;
		try {
			// `prevDue = null` on save means anchor the interval cadence on
			// "now" rather than carrying over the previous due time. Editing
			// a schedule is treated as a reset, which matches the user's
			// mental model — "every 30 minutes starting now" rather than
			// "the next fire was scheduled at X, keep that".
			const overrideActive = modelSource !== 'settings';
			const input: JobInput = {
				name: name.trim(),
				description: description.trim() ? description.trim() : null,
				working_dir: workingDir.trim(),
				// Jobs always run unattended, so tool calls are auto-approved.
				auto_approve_tools: true,
				job_type: jobType,
				schedule_kind: schedule.kind,
				schedule_config: scheduleToConfigJson(schedule),
				next_due_at: computeNextDueAt(schedule, null),
				// The type's own knobs, serialized by its definition — Rust
				// stores this verbatim.
				type_config: typeDef.configToJson($state.snapshot(typeConfig)),
				// Per-job remote model override. Only persisted when a specific
				// source is selected AND a base URL is set — otherwise the job
				// follows the Settings backend (all-null columns).
				model_remote_base_url: overrideActive && modelBaseUrl.trim() ? modelBaseUrl.trim() : null,
				model_remote_api_key:
					overrideActive && modelBaseUrl.trim() && modelApiKey.trim() ? modelApiKey.trim() : null,
				model_remote_api_key_id:
					overrideActive && modelBaseUrl.trim() && modelApiKeyId ? modelApiKeyId : null,
				model_remote_model_id:
					overrideActive && modelBaseUrl.trim() && modelModelId.trim() ? modelModelId.trim() : null,
				model_remote_context_size:
					overrideActive && modelBaseUrl.trim() && typeof modelContextSize === 'number'
						? modelContextSize
						: null,
				model_remote_vision_supported:
					overrideActive && modelBaseUrl.trim() && modelVision !== 'auto'
						? modelVision === 'yes'
						: null
			};
			const stepsToSave: JobStepInput[] = (typeDef.persistSteps ?? defaultPersistSteps)(
				$state.snapshot(steps)
			);

			let id: number;
			if (jobId === 'new') {
				const created = await createJob(input);
				if (created === null) {
					error = 'Failed to create job.';
					return;
				}
				id = created;
			} else {
				const ok = await updateJob(jobId, input);
				if (!ok) {
					error = 'Failed to save job.';
					return;
				}
				id = jobId;
			}

			const stepsOk = await replaceJobSteps(id, stepsToSave);
			if (!stepsOk) {
				error = 'Saved job but failed to save steps.';
				return;
			}
			onsaved(id);
		} finally {
			saving = false;
		}
	}

	// Collapsible editor sections (UI refresh): each group folds to a
	// one-line summary. Local UI state only — nothing here persists.
	type SectionId = 'basics' | 'where' | 'model' | 'type';
	let openSections = $state<Record<SectionId, boolean>>({
		basics: true,
		where: false,
		model: false,
		type: true
	});

	function toggleSection(id: SectionId) {
		openSections[id] = !openSections[id];
	}

	// Section title for the type-specific group (mock: "Steps", "Audit
	// setup", …). Falls back to the type's label for future job types.
	const typeSectionTitles: Partial<Record<JobType, string>> = {
		research: 'Steps',
		audit: 'Audit setup',
		guided_planning: 'Guided planning',
		autonomous_coding: 'Autonomous coding'
	};
	const typeSectionTitle = $derived(typeSectionTitles[jobType] ?? typeDef.label);

	function scheduleSummary(s: Schedule): string {
		switch (s.kind) {
			case 'manual':
				return 'Manual';
			case 'hourly':
				return 'Hourly';
			case 'daily':
				return `Daily ${s.time}`;
			case 'weekly':
				return `Weekly ${s.day} ${s.time}`;
			case 'interval':
				return `Every ${s.minutes} min`;
		}
	}

	const basicsSummary = $derived(`${name.trim() || 'Untitled'} · ${typeDef.label}`);
	const whereSummary = $derived(
		`${workingDir.trim() ? (workingDir.trim().split('/').filter(Boolean).pop() ?? workingDir.trim()) : 'No folder'} · ${scheduleSummary(schedule)}`
	);
	const modelSummary = $derived(
		modelSource === 'settings'
			? 'Settings default'
			: `${modelSource === 'openrouter' ? 'OpenRouter' : 'Remote'} · ${modelModelId.trim() || 'no model picked'}`
	);
	const typeSummary = $derived(
		jobType === 'research' ? `${steps.length} step${steps.length === 1 ? '' : 's'}` : ''
	);

	// Job delete awaits ConfirmDialog approval.
	let confirmingDelete = $state(false);

	async function deleteJobConfirmed() {
		confirmingDelete = false;
		if (jobId === 'new') return;
		saving = true;
		try {
			const deleted = await deleteJob(jobId);
			if (deleted) ondeleted();
			else error = 'Failed to delete job.';
		} finally {
			saving = false;
		}
	}
</script>

{#snippet collapseHead(id: SectionId, title: string, summary: string, pill: boolean = false)}
	<button
		type="button"
		class="collapse-head"
		aria-expanded={openSections[id]}
		onclick={() => toggleSection(id)}
	>
		<svg
			class="chevron"
			class:open={openSections[id]}
			width="12"
			height="12"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			stroke-width="3"
			stroke-linecap="round"
			stroke-linejoin="round"
			aria-hidden="true"
		>
			<polyline points="6 9 12 15 18 9"></polyline>
		</svg>
		<span class="collapse-title">{title}</span>
		{#if !openSections[id] && summary}
			<span class="collapse-summary" class:pill>{summary}</span>
		{/if}
	</button>
{/snippet}

<div class="job-editor">
	{#if loading}
		<p class="hint">Loading…</p>
	{:else}
		<div class="editor-scroll thin-scroll">
			<h3>{jobId === 'new' ? 'New job' : 'Edit job'}</h3>

			<section class="collapse">
				{@render collapseHead('basics', 'Basics', basicsSummary)}
				{#if openSections.basics}
					<div class="collapse-body">
						<!-- A dropdown, not radio cards: the registry keeps growing job types
						     and the picker's screen cost must not grow with it. The selected
						     type's description renders as the hint below.

						     Locked after first save: type_config is one JSON column, so saving
						     under a different type would overwrite the old type's config
						     irrecoverably (and orphan the run history's semantics). Create a
						     new job to use a different type. -->
						<label
							class="field"
							title={jobId !== 'new'
								? 'The job type is fixed after creation — create a new job to use a different type.'
								: undefined}
						>
							<span class="label">Job type</span>
							<select
								class="type-select"
								value={jobType}
								disabled={jobId !== 'new'}
								onchange={(e) => setJobType(e.currentTarget.value as JobType)}
							>
								{#each listJobTypes().filter((d) => isJobTypeAvailable(d.id) || d.id === jobType) as d (d.id)}
									<option value={d.id}>{d.label}</option>
								{/each}
							</select>
							<span class="hint">
								{typeDef.description}
								{#if jobId !== 'new'}(Type is fixed after creation.){/if}
							</span>
						</label>

						<label
							class="field"
							title="User-visible label shown in the job list. No effect on what the model sees."
						>
							<span class="label">Name</span>
							<input type="text" bind:value={name} placeholder="Morning headlines" />
						</label>

						<label
							class="field"
							title="Optional note for yourself — not sent to the model. Use it to remember the why behind the job."
						>
							<span class="label">Description</span>
							<input type="text" bind:value={description} placeholder="Optional" />
						</label>
					</div>
				{/if}
			</section>

			<section class="collapse">
				{@render collapseHead('where', 'Where & when', whereSummary)}
				{#if openSections.where}
					<div class="collapse-body">
						<div
							class="field"
							title={typeDef.workingDirPlaceholder
								? 'Required. Absolute path to the project this job reads and greps. Every run operates inside it.'
								: "Optional. Absolute path to a folder this job operates in. When set, every step sees it as the agent's working directory — file reads, writes, Python sandbox cwd. Leave blank for jobs that don't touch the filesystem (research, summarization, etc.) — the model just won't have fs_* tools available."}
						>
							<span class="label">
								Working directory
								{#if typeDef.workingDirPlaceholder}<span class="required">(required)</span
									>{:else}<span class="optional">(optional)</span>{/if}
							</span>
							<div class="workdir-row">
								<input
									type="text"
									bind:value={workingDir}
									placeholder={typeDef.workingDirPlaceholder ??
										"Leave blank if the job doesn't touch files"}
									class="workdir-input"
								/>
								<button
									type="button"
									class="btn"
									onclick={pickWorkingDir}
									title="Pick a folder using the system file dialog"
								>
									Browse…
								</button>
							</div>
						</div>

						<div class="field">
							<JobScheduleField {schedule} onchange={(s) => (schedule = s)} />
						</div>
					</div>
				{/if}
			</section>

			<section class="collapse">
				{@render collapseHead('model', 'Model', modelSummary, true)}
				{#if openSections.model}
					<div class="collapse-body">
						<div class="field">
							<ModeSelector
								name="job-model-source"
								value={modelSource}
								onchange={setModelSource}
								options={[
									{
										value: 'settings',
										title: 'Settings model (default)',
										description: 'Uses whatever backend Settings has active (local or remote).'
									},
									{
										value: 'remote',
										title: 'Remote server',
										description: "A specific OpenAI-compatible server for this job's runs."
									},
									{
										value: 'openrouter',
										title: 'OpenRouter (cloud)',
										description: 'A specific OpenRouter model — prompts leave your device.'
									}
								]}
							/>
							{#if modelSource !== 'settings'}
								<div class="model-fields">
									{#if modelSource === 'openrouter'}
										<div class="model-row">
											<label class="model-field grow">
												<span class="sublabel">API key</span>
												<ApiKeyPicker
													selectedId={modelApiKeyId}
													onSelect={(id) => {
														modelApiKeyId = id;
													}}
												/>
											</label>
											<button
												type="button"
												class="btn probe-btn"
												disabled={orLoading}
												title="Fetch the OpenRouter model catalog."
												onclick={loadOpenRouterModels}
												>{orLoading ? 'Loading…' : 'Load models'}</button
											>
										</div>
										{#if orCatalog}
											<div class="model-row">
												<label class="model-field grow">
													<span class="sublabel">Model</span>
													<OpenRouterModelPicker
														models={orCatalog}
														selectedId={modelModelId}
														onSelect={onOpenRouterModelSelect}
														toolsOnly={false}
													/>
												</label>
											</div>
										{/if}
										{#if orError}
											<span class="probe-status error-text">{orError}</span>
										{/if}
									{:else}
										<div class="model-row">
											<label class="model-field grow">
												<span class="sublabel">Server URL</span>
												<select
													value={modelBaseUrl}
													onchange={(e) => onServerUrlChange(e.currentTarget.value)}
												>
													{#if serverUrlOptions.length === 0}
														<option value="" disabled selected>
															No servers saved — add one in Settings
														</option>
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
												disabled={probing || !modelBaseUrl}
												title="Connect to the selected server to list its models and detect context size + vision."
												onclick={probeModel}>{probing ? 'Probing…' : 'Probe'}</button
											>
										</div>
										<div class="model-row">
											<label class="model-field grow">
												<span class="sublabel">Model</span>
												<select
													value={modelModelId}
													disabled={modelIdOptions.length === 0}
													onchange={(e) => onModelChange(e.currentTarget.value)}
												>
													{#if modelIdOptions.length === 0}
														<option value="" disabled selected
															>Probe the server to list models</option
														>
													{:else}
														{#each modelIdOptions as id (id)}
															<option value={id}>{id}</option>
														{/each}
													{/if}
												</select>
											</label>
											<label class="model-field grow">
												<span class="sublabel"
													>API key <span class="optional">(optional)</span></span
												>
												<ApiKeyPicker
													selectedId={modelApiKeyId}
													onSelect={(id) => {
														modelApiKeyId = id;
													}}
												/>
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
												bind:value={modelContextSize}
												placeholder="e.g. 131072 — blank = use Settings size"
											/>
										</label>
										<label
											class="model-field"
											title="Whether this model accepts image input. 'From probe / Settings' inherits the global capability; override it if the probe can't tell."
										>
											<span class="sublabel">Vision</span>
											<select bind:value={modelVision}>
												<option value="auto">From probe / Settings</option>
												<option value="yes">Supported</option>
												<option value="no">Not supported</option>
											</select>
										</label>
									</div>
								</div>
							{/if}
						</div>
					</div>
				{/if}
			</section>

			<!-- The selected type's own form section. Every editor gets the same
			     props (JobTypeEditorProps) and declares the subset it uses; the
			     key remounts it whenever the config object identity changes
			     (load, type switch), so mount-time initialization stays safe.
			     Folding the section unmounts the editor, but its state lives in
			     the bound typeConfig/steps, so nothing is lost. -->
			<section class="collapse">
				{@render collapseHead('type', typeSectionTitle, typeSummary)}
				{#if openSections.type}
					<div class="collapse-body">
						{#key `${jobId}:${jobType}`}
							<TypeEditor bind:config={typeConfig} bind:steps jobName={name} />
						{/key}
					</div>
				{/if}
			</section>
		</div>

		{#if error}
			<div class="error-box editor-error">{error}</div>
		{/if}

		<div class="actions">
			<div class="actions-left">
				{#if jobId !== 'new'}
					<button
						type="button"
						class="btn btn-danger"
						onclick={() => (confirmingDelete = true)}
						disabled={saving}
						title="Delete this job and its entire run history. Cannot be undone."
					>
						Delete
					</button>
				{/if}
			</div>
			<div class="actions-right">
				<button
					type="button"
					class="btn"
					onclick={oncancel}
					disabled={saving}
					title="Discard unsaved changes and return to the job list"
				>
					Cancel
				</button>
				<button
					type="button"
					class="btn btn-primary"
					onclick={save}
					disabled={saving}
					title="Save the job. Use the Run button in the job list to execute it manually."
				>
					{saving ? 'Saving…' : 'Save'}
				</button>
			</div>
		</div>
	{/if}
</div>

<ConfirmDialog
	open={confirmingDelete}
	title="Delete job?"
	message={`Delete job "${name}"? This cannot be undone.`}
	confirmLabel="Delete job"
	onconfirm={deleteJobConfirmed}
	oncancel={() => (confirmingDelete = false)}
/>

<style>
	/* The editor is a flex column: the sections scroll, the action footer
	   stays docked at the bottom. */
	.job-editor {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.editor-scroll {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px 20px 8px;
	}

	h3 {
		margin: 0 0 12px 0;
		font-size: 1rem;
		font-weight: 600;
	}

	/* Collapsible section shell + header. */
	.collapse {
		border: 1px solid var(--border);
		border-radius: 9px;
		overflow: hidden;
		margin-bottom: 10px;
	}

	.collapse-head {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 9px;
		padding: 11px 13px;
		background: var(--bg-secondary);
		border: none;
		cursor: pointer;
		color: var(--text-primary);
		text-align: left;
	}

	.chevron {
		flex: none;
		color: var(--text-muted);
		transform: rotate(-90deg);
		transition: transform 0.15s;
	}

	.chevron.open {
		color: var(--accent);
		transform: rotate(0deg);
	}

	.collapse-title {
		font-size: 0.82rem;
		font-weight: 600;
	}

	.collapse-summary {
		margin-left: auto;
		font-size: 0.74rem;
		color: var(--text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.collapse-summary.pill {
		background: var(--bg-raised);
		border: 1px solid var(--border-mid);
		border-radius: 999px;
		padding: 2px 9px;
	}

	.collapse-body {
		padding: 13px;
		border-top: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.type-select {
		align-self: flex-start;
		min-width: 240px;
	}

	.optional {
		font-weight: normal;
		opacity: 0.7;
	}

	.required {
		font-weight: normal;
		font-size: 0.82rem;
		color: var(--accent);
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

	.workdir-row {
		display: flex;
		gap: 6px;
	}

	.workdir-input {
		flex: 1;
		min-width: 0;
	}

	.hint {
		font-style: italic;
	}

	.editor-error {
		flex: none;
		margin: 0 20px 4px;
	}

	/* Docked action footer (never scrolls out of view). */
	.actions {
		flex: none;
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 12px 20px;
		border-top: 1px solid var(--border);
		background: var(--bg-primary);
	}

	.actions-right {
		display: flex;
		gap: 8px;
	}
</style>
