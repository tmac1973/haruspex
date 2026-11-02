<script lang="ts">
	/** Add card → Important emails: the digest's settings and how often it checks. */
	import Modal from '#lib/components/Modal.svelte';
	import JobScheduleField from '#lib/components/jobs/JobScheduleField.svelte';
	import EmailDigestEditor from '#lib/agent/jobs/types/email-digest/Editor.svelte';
	import { emailDigestJobType } from '#lib/agent/jobs/types/email-digest/definition.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';
	import type { Schedule } from '#lib/stores/jobs.svelte.ts';

	let { open, defaultSchedule, onadd, ondone }: CardFormProps = $props();

	let config = $state(emailDigestJobType.configDefaults());
	// The form opens fresh each time, so the card type's default is only a start.
	// svelte-ignore state_referenced_locally
	let schedule = $state<Schedule>(defaultSchedule);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const problem = $derived(
		emailDigestJobType.validate?.({ name: '', workingDir: '', steps: [], config }) ?? null
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

<Modal {open} title="Important emails" dismissable onclose={ondone} maxWidth={480}>
	<div class="form">
		<EmailDigestEditor bind:config />
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
