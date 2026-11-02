<script lang="ts">
	/** Home's Add card button: the card types on offer, and a job picker for a pinned job. */
	import JobPicker from '#lib/components/home/JobPicker.svelte';
	import { cardTypes, type CardType } from '#lib/home/cardTypes.ts';
	import { addCard } from '#lib/stores/homeCards.svelte.ts';
	import { createCardJob } from '#lib/home/cardJobs.ts';
	import type { Schedule } from '#lib/stores/jobs.svelte.ts';

	const addable = $derived(cardTypes().filter((t) => t.addable()));
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

	async function addWithJob(
		type: CardType,
		typeConfig: Record<string, unknown>,
		schedule: Schedule
	): Promise<boolean> {
		return (await createCardJob(type.id, typeConfig, schedule)) !== null;
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
			{#each addable as type (type.id)}
				<button role="menuitem" onclick={() => choose(type)}
					>{type.label}{type.kind === 'pinned' || type.form ? '…' : ''}</button
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
		onadd={(config, schedule) => addWithJob(type, config, schedule)}
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
</style>
