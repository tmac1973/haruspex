<script lang="ts">
	import { tick, untrack } from 'svelte';
	import { open } from '@tauri-apps/plugin-dialog';
	import JobModelFields from '$lib/components/jobs/JobModelFields.svelte';
	import {
		emptyModelForm,
		modelColumnsFromForm,
		modelFormFromColumns,
		modelFormSummary,
		modelAdvancedOf,
		type JobModelForm
	} from '$lib/agent/jobs/jobModelForm';
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
		// An interactive type can't run unattended, so it can't carry a
		// schedule across a type switch either.
		if (getJobType(next)?.supportsSchedule === false) schedule = { kind: 'manual' };
	}

	/**
	 * Whether this type's runs can fire unattended. Interactive types (guided
	 * planning, autonomous coding) open with an interview, so a scheduled fire
	 * would park on a question modal with nobody there — the field is hidden
	 * rather than disabled, since a schedule is not a thing they can have.
	 */
	const schedulable = $derived(typeDef.supportsSchedule !== false);
	// Where this job's model calls go, and how it behaves (any job type).
	// JobModelFields owns the fields; this is their saved state.
	let modelForm = $state<JobModelForm>(emptyModelForm());
	// Bumped per load, so the model fields remount and drop the previous
	// job's probe results.
	let modelFormVersion = $state(0);
	let loading = $state(false);
	let saving = $state(false);
	let error = $state<string | null>(null);

	/**
	 * Unsaved-changes tracking.
	 *
	 * Everything the form can persist, as one comparable string. Clicking a
	 * job's run arrow used to enqueue the STORED job while the editor held
	 * newer values, so a run silently executed the version the user thought
	 * they had just changed — the parent asks this before running or
	 * switching away.
	 *
	 * Signature-of-the-whole-form rather than per-field flags: a field added
	 * to the editor later is covered automatically, where a flag would have
	 * to be remembered.
	 */
	function formSignature(): string {
		return JSON.stringify({
			name,
			description,
			workingDir,
			schedule,
			steps: $state.snapshot(steps),
			jobType,
			typeConfig: $state.snapshot(typeConfig),
			model: modelColumnsFromForm(modelForm),
			// The columns above serialise `model_advanced`; the raw advanced
			// shape also catches a change serialisation would normalise away.
			advanced: modelAdvancedOf(modelForm)
		});
	}

	/** The form as loaded (or last saved). null until the first load settles. */
	let baseline = $state<string | null>(null);

	const dirty = $derived(baseline !== null && !loading && formSignature() !== baseline);

	/** Read by the Jobs tab before it runs this job or navigates away. */
	export function hasUnsavedChanges(): boolean {
		return dirty;
	}

	/** Save on the parent's behalf. False when validation rejected the form. */
	export async function saveNow(): Promise<boolean> {
		return save();
	}

	/**
	 * Snapshot the loaded form as the comparison point. Deferred by a tick so
	 * a type editor's own mount effects settle first — guided planning
	 * derives its output folder from the job name on mount, which would
	 * otherwise register as an edit the user never made.
	 */
	async function captureBaseline() {
		await tick();
		baseline = formSignature();
	}

	// Tracks jobId only. Loading reads state as well as writing it (the model
	// fields' remount counter), and a load that tracked what it reads would
	// re-run itself forever.
	$effect(() => {
		const id = jobId;
		untrack(() => loadIntoForm(id));
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
			modelForm = emptyModelForm();
			modelFormVersion++;
			void captureBaseline();
			return;
		}
		loading = true;
		baseline = null;
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
			modelForm = modelFormFromColumns(job);
			modelFormVersion++;
		} finally {
			loading = false;
		}
		void captureBaseline();
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

	/** True when the job (and its steps) reached the DB. */
	async function save(): Promise<boolean> {
		const v = validate();
		if (v) {
			error = v;
			// The offending field may be inside a folded section — unfold
			// everything so the error is visible and fixable.
			openSections = { basics: true, where: true, model: true, type: true };
			return false;
		}
		error = null;
		saving = true;
		try {
			// `prevDue = null` on save means anchor the interval cadence on
			// "now" rather than carrying over the previous due time. Editing
			// a schedule is treated as a reset, which matches the user's
			// mental model — "every 30 minutes starting now" rather than
			// "the next fire was scheduled at X, keep that".
			const input: JobInput = {
				name: name.trim(),
				description: description.trim() ? description.trim() : null,
				working_dir: workingDir.trim(),
				// Jobs always run unattended, so tool calls are auto-approved.
				auto_approve_tools: true,
				job_type: jobType,
				// Belt and braces: the field is hidden for interactive types, but a
				// job saved before this gate existed can still be carrying one.
				schedule_kind: schedulable ? schedule.kind : 'manual',
				schedule_config: schedulable ? scheduleToConfigJson(schedule) : null,
				next_due_at: schedulable ? computeNextDueAt(schedule, null) : null,
				// The type's own knobs, serialized by its definition — Rust
				// stores this verbatim.
				type_config: typeDef.configToJson($state.snapshot(typeConfig)),
				// The model columns: remote ones only for a specific source with
				// a URL; `model_advanced` either way. See jobModelForm.
				...modelColumnsFromForm($state.snapshot(modelForm))
			};
			const stepsToSave: JobStepInput[] = (typeDef.persistSteps ?? defaultPersistSteps)(
				$state.snapshot(steps)
			);

			let id: number;
			if (jobId === 'new') {
				const created = await createJob(input);
				if (created === null) {
					error = 'Failed to create job.';
					return false;
				}
				id = created;
			} else {
				const ok = await updateJob(jobId, input);
				if (!ok) {
					error = 'Failed to save job.';
					return false;
				}
				id = jobId;
			}

			const stepsOk = await replaceJobSteps(id, stepsToSave);
			if (!stepsOk) {
				error = 'Saved job but failed to save steps.';
				return false;
			}
			// Re-baseline before handing control back: `onsaved` may leave this
			// editor mounted (an existing job keeps its id), and a form that
			// still compares dirty against the pre-save values would prompt to
			// save changes that are already on disk.
			baseline = formSignature();
			onsaved(id);
			return true;
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
		[
			workingDir.trim()
				? (workingDir.trim().split('/').filter(Boolean).pop() ?? workingDir.trim())
				: 'No folder',
			...(schedulable ? [scheduleSummary(schedule)] : [])
		].join(' · ')
	);
	const modelSummary = $derived(modelFormSummary(modelForm));
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

						{#if schedulable}
							<div class="field">
								<JobScheduleField {schedule} onchange={(s) => (schedule = s)} />
							</div>
						{:else}
							<p class="hint">
								{typeDef.label} runs start by interviewing you, so they only run when you start them.
							</p>
						{/if}
					</div>
				{/if}
			</section>

			<section class="collapse">
				{@render collapseHead('model', 'Model', modelSummary, true)}
				{#if openSections.model}
					<div class="collapse-body">
						<div class="field">
							{#key modelFormVersion}
								<JobModelFields bind:form={modelForm} name="job-model-source" />
							{/key}
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
							<TypeEditor bind:config={typeConfig} bind:steps jobName={name} {workingDir} {jobId} />
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
					onclick={() => void save()}
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
	/* Not overflow: hidden. That clipped every dropdown inside a card (the
	   OpenRouter model list showed two rows); the header rounds its own
	   corners instead. */
	.collapse {
		border: 1px solid var(--border);
		border-radius: 9px;
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
		border-radius: 8px;
		cursor: pointer;
		color: var(--text-primary);
		text-align: left;
	}

	.collapse-head[aria-expanded='true'] {
		border-radius: 8px 8px 0 0;
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
