<script lang="ts">
	/**
	 * The Add card form for a card that owns a job (Important emails, News):
	 * its job type's editor section and how often the job runs. When the user
	 * already has jobs of that type, Use a job shows one of them instead.
	 */
	import Modal from '#lib/components/Modal.svelte';
	import JobScheduleField from '#lib/components/jobs/JobScheduleField.svelte';
	import type { JobTypeDefinition } from '#lib/agent/jobs/types/types.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';
	import type { Schedule } from '#lib/stores/jobs.svelte.ts';

	let {
		title,
		jobType,
		open,
		defaultSchedule,
		onadd,
		existingJobs = [],
		onuse,
		ondone
	}: CardFormProps & { title: string; jobType: JobTypeDefinition } = $props();

	const canUse = $derived(existingJobs.length > 0 && onuse !== undefined);
	let using = $state(false);
	// svelte-ignore state_referenced_locally
	let pickedId = $state<number | null>(existingJobs[0]?.id ?? null);

	// svelte-ignore state_referenced_locally
	let config = $state(jobType.configDefaults());
	// The form opens fresh each time, so the card type's default is only a start.
	// svelte-ignore state_referenced_locally
	let schedule = $state<Schedule>(defaultSchedule);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(
		jobType.validate?.({ name: '', workingDir: '', steps: [], config }) ?? null
	);

	const blocker = $derived(using ? (pickedId === null ? 'Pick a job.' : null) : problem);

	async function add() {
		if (blocker || saving) return;
		saving = true;
		error = null;
		try {
			const added =
				using && pickedId !== null && onuse
					? await onuse(pickedId)
					: // A plain copy: the settings go to the database, not a $state proxy.
						await onadd($state.snapshot(config), schedule);
			if (added) ondone();
			else error = 'The card could not be added.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} {title} dismissable onclose={ondone} maxWidth={480}>
	<div class="form">
		{#if canUse}
			<div class="segmented" role="group" aria-label="Job">
				<button type="button" class:active={!using} onclick={() => (using = false)}>New job</button>
				<button
					type="button"
					class:active={using}
					title="Show a {jobType.label} job you already have. It keeps its own settings and schedule."
					onclick={() => (using = true)}>Use a job</button
				>
			</div>
		{/if}
		{#if canUse && using}
			<label class="field">
				<span>Job</span>
				<select bind:value={pickedId}>
					{#each existingJobs as job (job.id)}
						<option value={job.id}>{job.name}</option>
					{/each}
				</select>
			</label>
		{:else}
			<jobType.Editor bind:config steps={[]} jobName={title} />
			<JobScheduleField {schedule} onchange={(next) => (schedule = next)} />
		{/if}
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={ondone}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void add()}
				disabled={blocker !== null || saving}
				title={blocker ?? undefined}>Add card</button
			>
		</div>
	</div>
</Modal>

<style>
	.form {
		display: flex;
		flex-direction: column;
		gap: 12px;
	}

	.buttons {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
	}

	.error {
		margin: 0;
		color: var(--error-text);
	}
</style>
