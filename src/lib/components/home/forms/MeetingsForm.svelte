<script lang="ts">
	/** Add card → Upcoming meetings: which calendars, and how far ahead. */
	import Modal from '#lib/components/Modal.svelte';
	import { enabledDavAccounts } from '#lib/stores/settings.ts';
	import { DEFAULT_MEETING_HOURS } from '#lib/home/meetings.ts';
	import type { CardFormProps } from '#lib/home/cardTypes.ts';

	let { open, defaultSchedule, onadd, ondone }: CardFormProps = $props();

	const accounts = enabledDavAccounts().filter((a) => a.hasCalendars !== false);
	let hours = $state(DEFAULT_MEETING_HOURS);
	/** Empty means every calendar account, including ones added later. */
	let accountIds = $state<string[]>([]);
	let saving = $state(false);
	let error = $state<string | null>(null);

	const valid = $derived(hours >= 1 && hours <= 72);

	function toggle(id: string, on: boolean) {
		accountIds = on ? [...accountIds, id] : accountIds.filter((a) => a !== id);
	}

	async function add() {
		if (!valid || saving) return;
		saving = true;
		error = null;
		try {
			if (await onadd({ hours, accountIds: [...accountIds] }, defaultSchedule)) ondone();
			else error = 'The card could not be added.';
		} finally {
			saving = false;
		}
	}
</script>

<Modal {open} title="Upcoming meetings" dismissable onclose={ondone} maxWidth={440}>
	<div class="form">
		<fieldset class="field">
			<legend class="label">Calendars</legend>
			<span class="hint">None ticked reads every calendar account.</span>
			{#each accounts as account (account.id)}
				<label class="check">
					<input
						type="checkbox"
						checked={accountIds.includes(account.id)}
						onchange={(e) => toggle(account.id, (e.currentTarget as HTMLInputElement).checked)}
					/>
					{account.label}
				</label>
			{/each}
		</fieldset>
		<label class="field">
			<span class="label">Look ahead (hours)</span>
			<input type="number" min="1" max="72" bind:value={hours} />
		</label>
		{#if error}
			<p class="error">{error}</p>
		{/if}
		<div class="buttons">
			<button type="button" class="btn" onclick={ondone}>Cancel</button>
			<button
				type="button"
				class="btn btn-primary"
				onclick={() => void add()}
				disabled={!valid || saving}>Add card</button
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

	fieldset {
		border: none;
		margin: 0;
		padding: 0;
	}

	.label {
		font-size: 0.82rem;
		color: var(--text-secondary);
	}

	.hint {
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.check {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 0.88rem;
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
