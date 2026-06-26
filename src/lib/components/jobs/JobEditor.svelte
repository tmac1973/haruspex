<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import { invoke } from '@tauri-apps/api/core';
	import { pickProbedModel, type NormalizedModel, type ProbeResult } from '$lib/inferenceProbe';
	import JobScheduleField from '$lib/components/jobs/JobScheduleField.svelte';
	import PromptCatalog from '$lib/components/jobs/PromptCatalog.svelte';
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
	import {
		DEFAULT_SAMPLE_INSTRUCTIONS,
		DEFAULT_VERIFY_INSTRUCTIONS
	} from '$lib/agent/jobs/auditPipeline';
	import { getSettings } from '$lib/stores/settings';

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
	// Audit-job config (only used when jobType === 'audit'). The audit prompt
	// itself reuses steps[0].prompt so the persistence path stays shared.
	let auditNumRuns = $state(5);
	let auditOutputFile = $state('AUDIT.md');
	let auditReadOnly = $state(true);
	let auditMaxTurns = $state(200);
	let auditSampleInstructions = $state(DEFAULT_SAMPLE_INSTRUCTIONS);
	let auditVerifyInstructions = $state(DEFAULT_VERIFY_INSTRUCTIONS);
	// Per-job remote model override (any job type). Off → the job uses the
	// global Settings backend; on → it runs against this remote server/model.
	let modelOverride = $state(false);
	let modelBaseUrl = $state('');
	let modelApiKey = $state('');
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
			auditNumRuns = 5;
			auditOutputFile = 'AUDIT.md';
			auditReadOnly = true;
			auditMaxTurns = 200;
			auditSampleInstructions = DEFAULT_SAMPLE_INSTRUCTIONS;
			auditVerifyInstructions = DEFAULT_VERIFY_INSTRUCTIONS;
			modelOverride = false;
			modelBaseUrl = '';
			modelApiKey = '';
			modelModelId = '';
			modelContextSize = '';
			modelVision = 'auto';
			probedModels = [];
			probeError = null;
			probeNote = null;
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
			auditNumRuns = job.audit_num_runs ?? 5;
			auditOutputFile = job.audit_output_file ?? '';
			auditReadOnly = job.audit_read_only;
			auditMaxTurns = job.audit_max_iterations ?? 200;
			auditSampleInstructions = job.audit_sample_instructions ?? DEFAULT_SAMPLE_INSTRUCTIONS;
			auditVerifyInstructions = job.audit_verify_instructions ?? DEFAULT_VERIFY_INSTRUCTIONS;
			modelOverride = !!job.model_remote_base_url;
			modelBaseUrl = job.model_remote_base_url ?? '';
			modelApiKey = job.model_remote_api_key ?? '';
			modelModelId = job.model_remote_model_id ?? '';
			modelContextSize = job.model_remote_context_size ?? '';
			modelVision =
				job.model_remote_vision_supported == null
					? 'auto'
					: job.model_remote_vision_supported
						? 'yes'
						: 'no';
			probedModels = [];
			probeError = null;
			probeNote = null;
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

	function addStep() {
		steps = [...steps, { prompt: '', deep_research: false }];
	}

	function removeStep(index: number) {
		if (steps.length === 1) {
			steps = [{ prompt: '', deep_research: false }];
			return;
		}
		steps = steps.filter((_, i) => i !== index);
	}

	function moveStep(index: number, direction: -1 | 1) {
		const target = index + direction;
		if (target < 0 || target >= steps.length) return;
		const next = [...steps];
		[next[index], next[target]] = [next[target], next[index]];
		steps = next;
	}

	function updateStepPrompt(index: number, value: string) {
		const next = [...steps];
		next[index] = { ...next[index], prompt: value };
		steps = next;
	}

	function toggleStepDeepResearch(index: number) {
		const next = [...steps];
		next[index] = { ...next[index], deep_research: !next[index].deep_research };
		steps = next;
	}

	// Server URLs saved in Settings — the options for the URL dropdown. A job
	// loaded with a URL no longer in Settings still shows it (union below) so
	// editing doesn't silently drop it.
	const savedServerUrls = $derived(getSettings().inferenceBackend.remoteServerUrls ?? []);
	const serverUrlOptions = $derived(
		[...new Set([...savedServerUrls, ...(modelBaseUrl ? [modelBaseUrl] : [])])].filter(Boolean)
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
		const m = probedModels.find((x) => x.id === id);
		if (!m) return;
		if (typeof m.context_size === 'number' && m.context_size > 0) modelContextSize = m.context_size;
		if (m.vision_supported != null) modelVision = m.vision_supported ? 'yes' : 'no';
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
			const result = await invoke<ProbeResult>('probe_inference_server', {
				baseUrl: modelBaseUrl.trim(),
				apiKey: modelApiKey.trim() || null
			});
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

	function validate(): string | null {
		if (!name.trim()) return 'Name is required.';
		if (jobType === 'audit') {
			if (!steps[0]?.prompt.trim()) return 'An audit prompt is required.';
			if (!workingDir.trim()) return 'Audit jobs need a working directory (the code to audit).';
			if (auditNumRuns < 1 || auditNumRuns > 20) return 'Number of runs must be between 1 and 20.';
			if (!Number.isFinite(auditMaxTurns) || auditMaxTurns < 1 || auditMaxTurns > 400)
				return 'Max turns per run must be between 1 and 400.';
			return null;
		}
		const nonEmpty = steps.filter((s) => s.prompt.trim().length > 0);
		if (nonEmpty.length === 0) return 'At least one step prompt is required.';
		return null;
	}

	async function save() {
		const v = validate();
		if (v) {
			error = v;
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
			const isAudit = jobType === 'audit';
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
				audit_num_runs: isAudit ? auditNumRuns : null,
				audit_output_file: isAudit && auditOutputFile.trim() ? auditOutputFile.trim() : null,
				audit_read_only: auditReadOnly,
				audit_max_iterations: isAudit ? auditMaxTurns : null,
				audit_sample_instructions:
					isAudit &&
					auditSampleInstructions.trim() &&
					auditSampleInstructions.trim() !== DEFAULT_SAMPLE_INSTRUCTIONS
						? auditSampleInstructions.trim()
						: null,
				audit_verify_instructions:
					isAudit &&
					auditVerifyInstructions.trim() &&
					auditVerifyInstructions.trim() !== DEFAULT_VERIFY_INSTRUCTIONS
						? auditVerifyInstructions.trim()
						: null,
				// Per-job remote model override. Only persisted when enabled AND a
				// base URL is set — otherwise the job follows the Settings backend.
				model_remote_base_url: modelOverride && modelBaseUrl.trim() ? modelBaseUrl.trim() : null,
				model_remote_api_key:
					modelOverride && modelBaseUrl.trim() && modelApiKey.trim() ? modelApiKey.trim() : null,
				model_remote_model_id:
					modelOverride && modelBaseUrl.trim() && modelModelId.trim() ? modelModelId.trim() : null,
				model_remote_context_size:
					modelOverride && modelBaseUrl.trim() && typeof modelContextSize === 'number'
						? modelContextSize
						: null,
				model_remote_vision_supported:
					modelOverride && modelBaseUrl.trim() && modelVision !== 'auto'
						? modelVision === 'yes'
						: null
			};
			// Audit jobs persist exactly one step (the audit prompt); research jobs
			// persist their full pipeline.
			const stepsToSave: JobStepInput[] = (isAudit ? steps.slice(0, 1) : steps)
				.map((s) => ({ prompt: s.prompt.trim(), deep_research: isAudit ? false : s.deep_research }))
				.filter((s) => s.prompt.length > 0);

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

	async function confirmDelete() {
		if (jobId === 'new') return;
		const ok = window.confirm(`Delete job "${name}"? This cannot be undone.`);
		if (!ok) return;
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

<div class="job-editor">
	{#if loading}
		<p class="hint">Loading…</p>
	{:else}
		<h3>{jobId === 'new' ? 'New job' : 'Edit job'}</h3>

		<div class="field">
			<span class="label">Job type</span>
			<div class="type-toggle" role="group" aria-label="Job type">
				<button
					type="button"
					class:active={jobType === 'research'}
					onclick={() => (jobType = 'research')}
					title="A sequential pipeline of steps; each step's output feeds the next."
				>
					Research
				</button>
				<button
					type="button"
					class:active={jobType === 'audit'}
					onclick={() => (jobType = 'audit')}
					title="Run one prompt N times independently, then cluster and source-verify the findings into one meta-report."
				>
					Audit
				</button>
			</div>
			<span class="hint">
				{jobType === 'audit'
					? 'Runs one prompt N times independently, then clusters and source-verifies the findings into a single meta-report — averaging out single-run noise.'
					: 'A sequential pipeline of steps; each step runs as a fresh conversation and its output feeds the next.'}
			</span>
		</div>

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

		<div
			class="field"
			title={jobType === 'audit'
				? 'Required. Absolute path to the codebase this audit reads and greps. Every run operates inside it.'
				: "Optional. Absolute path to a folder this job operates in. When set, every step sees it as the agent's working directory — file reads, writes, Python sandbox cwd. Leave blank for jobs that don't touch the filesystem (research, summarization, etc.) — the model just won't have fs_* tools available."}
		>
			<span class="label">
				Working directory
				{#if jobType === 'audit'}<span class="required">(required)</span>{:else}<span
						class="optional">(optional)</span
					>{/if}
			</span>
			<div class="workdir-row">
				<input
					type="text"
					bind:value={workingDir}
					placeholder={jobType === 'audit'
						? 'Absolute path to the code to audit'
						: "Leave blank if the job doesn't touch files"}
					class="workdir-input"
				/>
				<button
					type="button"
					class="secondary"
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

		<div
			class="field"
			title="Run this job against a specific remote model instead of the app's current Settings backend."
		>
			<label class="model-toggle">
				<input type="checkbox" bind:checked={modelOverride} />
				<span class="label">Use a specific remote model for this job</span>
			</label>
			<span class="hint">
				Off → uses whatever model Settings has active (local or remote). On → every run of this job
				calls the remote server below instead. Remote only; local jobs follow Settings.
			</span>
			{#if modelOverride}
				<div class="model-fields">
					<div class="model-row">
						<label class="model-field grow">
							<span class="sublabel">Server URL</span>
							<select
								value={modelBaseUrl}
								onchange={(e) => onServerUrlChange(e.currentTarget.value)}
							>
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
							class="secondary probe-btn"
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
							<input type="password" bind:value={modelApiKey} placeholder="Bearer token" />
						</label>
					</div>
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
					{#if probeError}
						<span class="probe-status error">Probe failed: {probeError}</span>
					{:else if probeNote}
						<span class="probe-status">{probeNote}</span>
					{/if}
				</div>
			{/if}
		</div>

		{#if jobType === 'research'}
			<div
				class="field steps"
				title="Each step is one prompt that runs as a fresh conversation with the model — no history between steps. The previous step's final reply is automatically prepended to the next step's prompt, so step 2 can act on step 1's output. Use this to decompose multi-objective work that a small model struggles to do in one shot."
			>
				<div class="steps-header">
					<span class="label">Steps</span>
					<span class="hint">
						Each step runs in a fresh conversation. The previous step's output is automatically
						prepended to the next step's prompt.
					</span>
				</div>
				{#each steps as step, i (i)}
					<div class="step">
						<div class="step-head">
							<div class="step-head-left">
								<span class="step-num">Step {i + 1}</span>
								<button
									type="button"
									class="research-toggle"
									class:active={step.deep_research}
									onclick={() => toggleStepDeepResearch(i)}
									title={step.deep_research
										? 'Deep research ON — this step will search more sources'
										: 'Deep research OFF — normal search for this step'}
									aria-pressed={step.deep_research}
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										stroke-width="2"
										stroke-linecap="round"
										stroke-linejoin="round"
									>
										<circle cx="11" cy="11" r="8"></circle>
										<line x1="21" y1="21" x2="16.65" y2="16.65"></line>
										{#if step.deep_research}
											<line x1="11" y1="8" x2="11" y2="14"></line>
											<line x1="8" y1="11" x2="14" y2="11"></line>
										{/if}
									</svg>
									<span>Deep research</span>
								</button>
							</div>
							<div class="step-actions">
								<PromptCatalog
									jobType="research"
									current={step.prompt}
									oninsert={(t) => updateStepPrompt(i, t)}
								/>
								<button
									type="button"
									class="icon-btn"
									title="Move up"
									disabled={i === 0}
									onclick={() => moveStep(i, -1)}
								>
									↑
								</button>
								<button
									type="button"
									class="icon-btn"
									title="Move down"
									disabled={i === steps.length - 1}
									onclick={() => moveStep(i, 1)}
								>
									↓
								</button>
								<button
									type="button"
									class="icon-btn danger"
									title="Remove step"
									onclick={() => removeStep(i)}
								>
									×
								</button>
							</div>
						</div>
						<textarea
							value={step.prompt}
							oninput={(e) => updateStepPrompt(i, (e.currentTarget as HTMLTextAreaElement).value)}
							placeholder={i === 0
								? 'What should this step do?'
								: 'Will receive the previous step’s output as context.'}
							title={i === 0
								? 'Plain instruction for this step. The model sees this verbatim as the user message in a fresh chat with full tool access (search, file ops, Python sandbox).'
								: "Plain instruction. At run time the previous step's reply is automatically prepended, so you can write this assuming the prior output is already in front of the model (e.g. 'Turn the above headlines into a PDF')."}
							rows="3"
						></textarea>
					</div>
				{/each}
				<button
					type="button"
					class="secondary add-step"
					onclick={addStep}
					title="Add another step to the pipeline. Runs after the previous step completes."
				>
					+ Add step
				</button>
			</div>
		{:else}
			<div class="field" title="The instruction each sample run executes, independently.">
				<div class="field-head">
					<span class="label">Audit prompt</span>
					<PromptCatalog
						jobType="audit"
						current={steps[0]?.prompt ?? ''}
						oninsert={(t) => updateStepPrompt(0, t)}
					/>
				</div>
				<span class="hint">
					Run {auditNumRuns}× independently. Ask for findings anchored to files and line ranges.
				</span>
				<textarea
					value={steps[0]?.prompt ?? ''}
					oninput={(e) => updateStepPrompt(0, (e.currentTarget as HTMLTextAreaElement).value)}
					placeholder="e.g. Find every instance of duplicated logic in this codebase. Anchor each finding to a file and line range, with a short explanation."
					rows="4"
				></textarea>
			</div>

			<div class="audit-grid">
				<label class="field" title="How many independent sample runs to execute (1–20).">
					<span class="label">Number of runs</span>
					<input type="number" min="1" max="20" bind:value={auditNumRuns} />
				</label>
				<label
					class="field"
					title="Agent-loop turn budget per run — how many read/grep steps each sample may take before it must report. A thorough audit of a large codebase can need 100+. Default 200, max 400."
				>
					<span class="label">Max turns per run</span>
					<input type="number" min="1" max="400" step="10" bind:value={auditMaxTurns} />
				</label>
				<label
					class="field span2"
					title="File (relative to the working directory) the final meta-report is written to. Leave blank to only keep it in the run record."
				>
					<span class="label">Output file <span class="optional">(optional)</span></span>
					<input type="text" bind:value={auditOutputFile} placeholder="AUDIT.md" />
				</label>
			</div>

			<label
				class="field checkbox"
				title="When ON (recommended), sample and verification runs may read and grep the code but cannot modify files."
			>
				<input type="checkbox" bind:checked={auditReadOnly} />
				<span>
					Read-only runs
					<span class="hint inline"
						>(recommended — sample runs read/grep but never modify files)</span
					>
				</span>
			</label>

			<details class="advanced-prompts">
				<summary>Advanced: edit the exact prompts sent to the model</summary>
				<p class="hint">
					Both are sent verbatim to the model. The <code>submit_findings</code> /
					<code>submit_verdict</code> calls are enforced automatically, so editing won't break
					capture — but a poor prompt can hurt result quality. Use <strong>Reset</strong> to restore the
					default.
				</p>

				<div class="field">
					<span class="label-row">
						<span class="label">Per-run addendum</span>
						<button
							type="button"
							class="reset-btn"
							disabled={auditSampleInstructions === DEFAULT_SAMPLE_INSTRUCTIONS}
							onclick={() => (auditSampleInstructions = DEFAULT_SAMPLE_INSTRUCTIONS)}
						>
							Reset
						</button>
					</span>
					<span class="hint">
						Appended after your audit prompt on every sample run (phase 1) — investigation guidance
						plus how to report findings.
					</span>
					<textarea bind:value={auditSampleInstructions} rows="6"></textarea>
				</div>

				<div class="field">
					<span class="label-row">
						<span class="label">Verification instructions</span>
						<button
							type="button"
							class="reset-btn"
							disabled={auditVerifyInstructions === DEFAULT_VERIFY_INSTRUCTIONS}
							onclick={() => (auditVerifyInstructions = DEFAULT_VERIFY_INSTRUCTIONS)}
						>
							Reset
						</button>
					</span>
					<span class="hint">
						Sent to the model that re-checks each finding against the source (phase 3) before it's
						kept; the finding's location/claim is prepended automatically.
					</span>
					<textarea bind:value={auditVerifyInstructions} rows="8"></textarea>
				</div>
			</details>
		{/if}

		{#if error}
			<div class="error">{error}</div>
		{/if}

		<div class="actions">
			<div class="actions-left">
				{#if jobId !== 'new'}
					<button
						type="button"
						class="danger"
						onclick={confirmDelete}
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
					class="secondary"
					onclick={oncancel}
					disabled={saving}
					title="Discard unsaved changes and return to the job list"
				>
					Cancel
				</button>
				<button
					type="button"
					class="primary"
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

<style>
	.job-editor {
		flex: 1;
		min-width: 0;
		padding: 16px 20px;
		overflow-y: auto;
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	h3 {
		margin: 0 0 4px 0;
		font-size: 1rem;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field.checkbox {
		flex-direction: row;
		align-items: flex-start;
		gap: 8px;
		font-size: 0.88rem;
	}

	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
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

	input[type='text'],
	input[type='number'] {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9rem;
	}

	.type-toggle {
		display: inline-flex;
		gap: 0;
		border: 1px solid var(--border);
		border-radius: 6px;
		overflow: hidden;
		align-self: flex-start;
	}

	.type-toggle button {
		padding: 5px 16px;
		border: none;
		border-radius: 0;
		background: var(--bg-primary);
		color: var(--text-secondary);
		font-size: 0.85rem;
		cursor: pointer;
	}

	.type-toggle button:first-child {
		border-right: 1px solid var(--border);
	}

	.type-toggle button.active {
		background: var(--accent);
		color: white;
	}

	.audit-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}

	.audit-grid .span2 {
		grid-column: 1 / -1;
	}

	.field-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.model-toggle {
		display: flex;
		align-items: center;
		gap: 8px;
		cursor: pointer;
	}

	.model-toggle input {
		width: auto;
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

	.probe-status.error {
		color: var(--error, #e5534b);
	}

	.advanced-prompts {
		border: 1px solid var(--border);
		border-radius: 4px;
		padding: 8px 10px;
	}

	.advanced-prompts > summary {
		cursor: pointer;
		font-size: 0.82rem;
		color: var(--text-secondary);
		user-select: none;
	}

	.advanced-prompts .field {
		margin-top: 10px;
	}

	.advanced-prompts code {
		font-size: 0.85em;
	}

	.label-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.reset-btn {
		padding: 2px 8px;
		font-size: 0.72rem;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
	}

	.reset-btn:hover:not(:disabled) {
		border-color: var(--text-secondary);
		color: var(--text-primary);
	}

	.reset-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	textarea {
		padding: 8px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-family: inherit;
		font-size: 0.9rem;
		line-height: 1.4;
		resize: vertical;
		min-height: 60px;
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
		font-size: 0.78rem;
		color: var(--text-secondary);
		font-style: italic;
	}

	.hint.inline {
		font-style: normal;
		margin-left: 4px;
	}

	.steps-header {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 4px;
	}

	.step {
		display: flex;
		flex-direction: column;
		gap: 4px;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
	}

	.step-head {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 8px;
	}

	.step-head-left {
		display: flex;
		align-items: center;
		gap: 8px;
		min-width: 0;
	}

	.step-num {
		font-size: 0.78rem;
		font-weight: 600;
		color: var(--text-secondary);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.research-toggle {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 2px 8px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 999px;
		font-size: 0.72rem;
		cursor: pointer;
	}

	.research-toggle:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.research-toggle.active {
		background: color-mix(in srgb, var(--accent) 15%, transparent);
		border-color: var(--accent);
		color: var(--accent);
	}

	.step-actions {
		display: flex;
		gap: 2px;
	}

	.icon-btn {
		width: 24px;
		height: 24px;
		border: 1px solid var(--border);
		background: var(--bg-primary);
		color: var(--text-secondary);
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.85rem;
		line-height: 1;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}

	.icon-btn:hover:not(:disabled) {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.icon-btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.icon-btn.danger:hover:not(:disabled) {
		color: var(--error-text);
		border-color: var(--error-border);
		background: var(--error-bg);
	}

	.add-step {
		align-self: flex-start;
	}

	.error {
		padding: 8px 10px;
		background: var(--error-bg);
		color: var(--error-text);
		border: 1px solid var(--error-border);
		border-radius: 4px;
		font-size: 0.85rem;
	}

	.actions {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding-top: 8px;
		border-top: 1px solid var(--border);
	}

	.actions-right {
		display: flex;
		gap: 8px;
	}

	button {
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid var(--border);
		font-size: 0.85rem;
		cursor: pointer;
	}

	button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	button.secondary {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	button.secondary:hover:not(:disabled) {
		border-color: var(--text-secondary);
	}

	button.primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	button.primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	button.danger {
		background: transparent;
		color: var(--error-text);
		border-color: var(--error-border);
	}

	button.danger:hover:not(:disabled) {
		background: var(--error-bg);
	}
</style>
