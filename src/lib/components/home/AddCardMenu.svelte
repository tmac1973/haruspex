<script lang="ts">
	/**
	 * Home's Add card button: every card type, those that need something set
	 * up first greyed out with what to set up; and a job picker for a pinned job.
	 */
	import JobPicker from '#lib/components/home/JobPicker.svelte';
	import { cardTypes, type CardType } from '#lib/home/cardTypes.ts';
	import { addCard } from '#lib/stores/homeCards.svelte.ts';
	import { createCardJob } from '#lib/home/cardJobs.ts';
	import { refreshCard } from '#lib/home/fetchedCards.svelte.ts';
	import { getLiveSettings } from '#lib/stores/settings.ts';
	import type { Schedule } from '#lib/stores/jobs.svelte.ts';

	// Home stays mounted, so this follows the settings: an account added in
	// Settings is offered without a restart.
	const options = $derived.by(() => {
		void getLiveSettings();
		return cardTypes().map((type) => ({ type, reason: type.unavailable?.() ?? null }));
	});
	let open = $state(false);
	/** The pinned-job type, while its job picker shows. */
	let picking = $state<CardType | null>(null);
	/** The card type whose Add card form shows. */
	let filling = $state<CardType | null>(null);

	function choose(type: CardType) {
		open = false;
		if (type.kind === 'pinned') picking = type;
		else if (type.form) filling = type;
		else void addCard(type.id, {}, null, type.defaultSize);
	}

	/** A judged card makes its job; a fetched card keeps its settings and reads its source now. */
	async function addFromForm(
		type: CardType,
		config: Record<string, unknown>,
		schedule: Schedule
	): Promise<boolean> {
		if (type.jobType) return (await createCardJob(type.id, config, schedule)) !== null;
		const card = await addCard(type.id, config, null, type.defaultSize);
		if (card) void refreshCard(card);
		return card !== null;
	}

	function pick(jobId: number) {
		const type = picking;
		picking = null;
		if (type) void addCard(type.id, {}, jobId, type.defaultSize);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (open && e.key === 'Escape') open = false;
	}}
/>

<div class="add-host">
	<button class="add-btn" onclick={() => (open = !open)} aria-haspopup="menu" aria-expanded={open}
		>Add card</button
	>
	{#if open}
		<div class="menu" role="menu" aria-label="Add card">
			{#each options as { type, reason } (type.id)}
				<!-- aria-disabled, not disabled: the reason's tooltip needs the hover. -->
				<button
					role="menuitem"
					aria-disabled={reason !== null}
					title={reason ?? undefined}
					onclick={() => {
						if (reason === null) choose(type);
					}}>{type.label}{type.kind === 'pinned' || type.form ? '…' : ''}</button
				>
			{/each}
		</div>
	{/if}
</div>

<JobPicker open={picking !== null} onpick={pick} oncancel={() => (picking = null)} />
{#if filling?.form}
	{@const type = filling}
	<type.form
		open
		defaultSchedule={type.defaultSchedule ?? { kind: 'interval', minutes: 30 }}
		onadd={(config, schedule) => addFromForm(type, config, schedule)}
		ondone={() => (filling = null)}
	/>
{/if}

<style>
	.add-host {
		position: relative;
	}

	.add-btn {
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.add-btn:hover {
		border-color: var(--text-secondary);
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 10;
		display: flex;
		flex-direction: column;
		min-width: 160px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-secondary);
		overflow: hidden;
	}

	.menu button {
		text-align: left;
		padding: 6px 10px;
		border: none;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
	}

	.menu button + button {
		border-top: 1px solid var(--border);
	}

	.menu button:hover {
		background: var(--bg-primary);
	}

	.menu button[aria-disabled='true'] {
		color: var(--text-secondary);
		opacity: 0.6;
		cursor: default;
	}

	.menu button[aria-disabled='true']:hover {
		background: none;
	}
</style>
