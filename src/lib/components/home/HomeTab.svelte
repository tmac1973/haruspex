<script lang="ts">
	import { onMount } from 'svelte';
	import AddCardMenu from '#lib/components/home/AddCardMenu.svelte';
	import CardFrame from '#lib/components/home/CardFrame.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { getCardType } from '#lib/home/cardTypes.ts';
	import {
		getHomeCards,
		isHomeCardsLoaded,
		loadHomeCards,
		moveCard,
		removeCard,
		setCardNotify,
		setCardSize
	} from '#lib/stores/homeCards.svelte.ts';
	import { ownsJob } from '#lib/home/cardJobs.ts';
	import { isRefreshing, refreshCard } from '#lib/home/fetchedCards.svelte.ts';
	import { selectJob } from '#lib/stores/jobsTabSelection.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { isJobsLoaded, loadJobs } from '#lib/stores/jobs.svelte.ts';
	import { getCurrentRun } from '#lib/agent/jobs/runner.svelte.ts';
	import type { HomeCard } from '#lib/ipc/gen/HomeCard.ts';

	const cards = $derived(getHomeCards());

	/** The card whose Remove asks first, because a job comes with it. */
	let removing = $state<HomeCard | null>(null);
	let alsoDeleteJob = $state(false);
	const removingJobRuns = $derived(
		removing !== null &&
			getCurrentRun()?.status === 'running' &&
			getCurrentRun()?.jobId === removing.job_id
	);

	onMount(() => {
		void loadHomeCards();
		// Pinned cards are titled by their job's name.
		if (!isJobsLoaded()) void loadJobs();
	});

	function askRemove(card: HomeCard) {
		if (card.job_id === null) {
			void removeCard(card.id);
			return;
		}
		// A card's own job goes with it by default; a pinned job stays.
		alsoDeleteJob = ownsJob(card);
		removing = card;
	}

	function editJob(jobId: number) {
		selectJob(jobId);
		setActiveTab('jobs');
	}

	function confirmRemove() {
		const card = removing;
		removing = null;
		if (card) void removeCard(card.id, { deleteJob: alsoDeleteJob && !removingJobRuns });
	}
</script>

<div class="home">
	<div class="toolbar">
		<AddCardMenu />
	</div>

	{#if isHomeCardsLoaded() && cards.length === 0}
		<p class="empty">No cards. Add one to see it here.</p>
	{/if}

	<div class="grid">
		{#each cards as card, i (card.id)}
			{@const type = getCardType(card.card_type)}
			<!-- A pinned card whose job was deleted can only be removed. -->
			{@const orphan = type?.kind === 'pinned' && card.job_id === null}
			<CardFrame
				title={type ? (type.title?.(card) ?? type.label) : 'Unknown card'}
				size={card.size === 'wide' ? 'wide' : 'normal'}
				canMoveUp={i > 0}
				canMoveDown={i < cards.length - 1}
				arrangeable={type !== undefined && !orphan}
				onmove={(dir) => void moveCard(card.id, dir)}
				onresize={(size) => void setCardSize(card.id, size)}
				onrefresh={type?.fetch ? () => void refreshCard(card) : undefined}
				refreshing={isRefreshing(card.id)}
				updatedAt={type?.fetch ? card.updated_at : null}
				onedit={card.job_id === null ? undefined : () => editJob(card.job_id as number)}
				notify={type?.notifies ? card.notify : null}
				onnotify={(on) => void setCardNotify(card.id, on)}
				onremove={() => askRemove(card)}
			>
				{#if type}
					<type.component {card} />
				{:else}
					<p class="muted">This card's type isn't available in this version.</p>
				{/if}
			</CardFrame>
		{/each}
	</div>
</div>

<ConfirmDialog
	open={removing !== null}
	title="Remove card"
	confirmLabel="Remove card"
	onconfirm={confirmRemove}
	oncancel={() => (removing = null)}
>
	<p>
		{removing && ownsJob(removing)
			? 'This card made its job; it goes with the card unless you untick the box.'
			: 'The job stays in the Jobs tab unless you delete it too.'}
	</p>
	<label class="also" title={removingJobRuns ? 'The job is running' : undefined}>
		<input type="checkbox" bind:checked={alsoDeleteJob} disabled={removingJobRuns} />
		Also delete the job
	</label>
</ConfirmDialog>

<style>
	.home {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 16px;
	}

	.toolbar {
		display: flex;
		justify-content: flex-end;
		margin-bottom: 12px;
	}

	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		gap: 12px;
		align-items: start;
	}

	@media (max-width: 700px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}

	.empty,
	.muted {
		color: var(--text-secondary);
	}

	.also {
		display: flex;
		align-items: center;
		gap: 6px;
	}
</style>
