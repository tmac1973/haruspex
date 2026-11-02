<script lang="ts">
	/**
	 * The Add card form for a card that owns a job (Important emails, News):
	 * its job type's editor section and how often the job runs.
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
		ondone
	}: CardFormProps & { title: string; jobType: JobTypeDefinition } = $props();

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

	async function add() {
		if (problem || saving) return;
		saving = true;
		error = null;
		try {
			// A plain copy: the settings go to the database, not a $state proxy.
			if (await onadd($state.snapshot(config), schedule)) ondone();
			else error = 'The card could not be added.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} {title} dismissable onclose={ondone} maxWidth={480}>
	<div class="form">
		<jobType.Editor bind:config steps={[]} jobName={title} />
		<JobScheduleField {schedule} onchange={(next) => (schedule = next)} />
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={ondone}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void add()}
				disabled={problem !== null || saving}
				title={problem ?? undefined}>Add card</button
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
