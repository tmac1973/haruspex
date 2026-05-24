<script lang="ts">
	import { open } from '@tauri-apps/plugin-dialog';
	import JobScheduleField from '$lib/components/jobs/JobScheduleField.svelte';
	import {
		createJob,
		updateJob,
		deleteJob,
		getJob,
		replaceJobSteps,
		scheduleToConfigJson,
		configJsonToSchedule,
		type Schedule,
		type JobInput,
		type JobStepInput
	} from '$lib/stores/jobs.svelte';

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
	let autoApprove = $state(false);
	let schedule = $state<Schedule>({ kind: 'manual' });
	let steps = $state<JobStepInput[]>([{ prompt: '', deep_research: false }]);
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
			autoApprove = false;
			schedule = { kind: 'manual' };
			steps = [{ prompt: '', deep_research: false }];
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
			autoApprove = job.auto_approve_tools;
			schedule = configJsonToSchedule(job.schedule_kind, job.schedule_config) ?? {
				kind: 'manual'
			};
			steps =
				job.steps.length > 0
					? job.steps.map((s) => ({ prompt: s.prompt, deep_research: s.deep_research }))
					: [{ prompt: '', deep_research: false }];
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

	function validate(): string | null {
		if (!name.trim()) return 'Name is required.';
		if (!workingDir.trim()) return 'Working directory is required.';
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
			const input: JobInput = {
				name: name.trim(),
				description: description.trim() ? description.trim() : null,
				working_dir: workingDir.trim(),
				auto_approve_tools: autoApprove,
				schedule_kind: schedule.kind,
				schedule_config: scheduleToConfigJson(schedule)
			};
			const stepsToSave: JobStepInput[] = steps
				.map((s) => ({ prompt: s.prompt.trim(), deep_research: s.deep_research }))
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
			title="Absolute path to the folder this job operates in. Every step in the run sees this as its working directory — file reads, writes, Python sandbox cwd. Per-step overrides aren't supported yet."
		>
			<span class="label">Working directory</span>
			<div class="workdir-row">
				<input
					type="text"
					bind:value={workingDir}
					placeholder="/path/to/folder"
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

		<label
			class="field checkbox"
			title="When ON, every tool call the model makes during a run is auto-allowed (file writes, sandbox code, overwriting existing files). When OFF, the run pauses on each prompt waiting for you to click — which defeats unattended/scheduled runs."
		>
			<input type="checkbox" bind:checked={autoApprove} />
			<span>
				Auto-approve tool calls during runs
				<span class="hint inline">
					(required for scheduled runs to complete without you watching)
				</span>
			</span>
		</label>

		<div class="field">
			<JobScheduleField {schedule} onchange={(s) => (schedule = s)} />
		</div>

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

	input[type='text'] {
		padding: 6px 10px;
		border: 1px solid var(--border);
		border-radius: 4px;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-size: 0.9rem;
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
