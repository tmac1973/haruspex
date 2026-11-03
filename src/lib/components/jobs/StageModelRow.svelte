<script lang="ts">
	// One stage's model as a row: its summary and a Change… button. The full
	// model form opens in a dialog; inline, each stage's form (with its own
	// advanced fold) sat inside the type section, three levels deep. Used for
	// guided planning's chained stages and the 3D job's two models.
	import Tooltip from '#lib/components/Tooltip.svelte';
	import JobModelFields from '#lib/components/jobs/JobModelFields.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import {
		emptyModelForm,
		modelColumnsFromForm,
		modelFormSummary,
		stageModelProblem,
		type JobModelForm
	} from '#lib/agent/jobs/jobModelForm.ts';
	import { backendOverrideFor } from '#lib/agent/jobs/jobBackend.ts';
	import { resolveBackendDescriptor } from '#lib/inference/descriptor.ts';

	let {
		label,
		tip,
		form = $bindable(),
		jobForm,
		warnNoVision = false
	}: {
		label: string;
		tip: string;
		/** The stage's own model; null = same as this job. */
		form: JobModelForm | null;
		/** The job's own model, which "Same as this job" means. */
		jobForm?: JobModelForm;
		/** Say so when the stage's model cannot see images. */
		warnNoVision?: boolean;
	} = $props();

	// "Same as this job" is the job's model. The Settings model is a different
	// choice whenever this job has its own server: the local model for one
	// stage, say, while the job runs remotely.
	const STAGE_SETTINGS = {
		title: 'Settings model',
		description:
			'Whatever Settings → Inference has active — the local model, or the server set there.'
	};

	let editing = $state(false);
	const lower = $derived(label.toLowerCase());
	const problem = $derived(stageModelProblem(lower, form));
	const summary = $derived(
		!form
			? 'Same as this job'
			: form.source === 'settings'
				? STAGE_SETTINGS.title
				: modelFormSummary(form)
	);

	/** Whether the model this stage runs on can see, as the run will resolve it. */
	function canSee(f: JobModelForm): boolean {
		if (f.vision !== 'auto') return f.vision === 'yes';
		return resolveBackendDescriptor(backendOverrideFor(modelColumnsFromForm(f))).vision;
	}

	const blind = $derived.by(() => {
		if (!warnNoVision) return false;
		const effective = form ?? jobForm;
		return effective ? !canSee(effective) : false;
	});

	function choose(choice: string) {
		form = choice === 'choose' ? (form ?? emptyModelForm('remote')) : null;
	}
</script>

<div class="stage">
	<div class="stage-row" class:missing={problem !== null}>
		<span class="label stage-name">
			{label}
			<Tooltip label={`About the ${lower}`} text={tip} />
		</span>
		<span class="stage-value" title={problem ?? undefined}>{summary}</span>
		<button
			type="button"
			class="btn btn-small"
			aria-label={`Change the ${lower}`}
			onclick={() => (editing = true)}
		>
			Change…
		</button>
	</div>
	{#if blind}
		<p class="hint">No vision: it works from the text report only.</p>
	{/if}
</div>

<Modal open={editing} title={label} dismissable onclose={() => (editing = false)}>
	{#if editing}
		<div class="stage-dialog">
			<select
				value={form ? 'choose' : 'same'}
				onchange={(e) => choose(e.currentTarget.value)}
				aria-label={label}
			>
				<option value="same">Same as this job</option>
				<option value="choose">Choose…</option>
			</select>
			{#if form}
				<JobModelFields
					bind:form
					name={`${lower.replace(/\W+/g, '-')}-source`}
					settingsLabel={STAGE_SETTINGS}
				/>
			{/if}
			<div class="dialog-actions">
				<button type="button" class="btn btn-primary" onclick={() => (editing = false)}>
					Done
				</button>
			</div>
		</div>
	{/if}
</Modal>

<style>
	.stage {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.stage-row {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 6px 6px 6px 12px;
		border: 1px solid var(--border-strong);
		border-radius: 8px;
		background: var(--bg-input);
	}

	/* Amber until a save is refused, then red: the editor marks its root. */
	.stage-row.missing {
		border-color: var(--warning);
	}

	:global(.job-editor.attempted) .stage-row.missing {
		border-color: var(--error-text);
	}

	.label {
		display: inline-flex;
		align-items: center;
		gap: 2px;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.stage-name {
		flex: none;
		min-width: 140px;
	}

	.stage-value {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.hint {
		margin: 0 0 0 12px;
		font-size: 0.8rem;
		color: var(--warning);
	}

	.stage-dialog {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.dialog-actions {
		display: flex;
		justify-content: flex-end;
	}
</style>
