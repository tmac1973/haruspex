<script lang="ts">
	import { onMount } from 'svelte';
	import AddCardMenu from '#lib/components/home/AddCardMenu.svelte';
	import CardFrame from '#lib/components/home/CardFrame.svelte';
	import SummaryBand from '#lib/components/home/SummaryBand.svelte';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { getCardType, type CardType } from '#lib/home/cardTypes.ts';
	import {
		getHomeCards,
		isHomeCardsLoaded,
		loadHomeCards,
		moveCard,
		moveCardTo,
		removeCard,
		setCardNotify,
		setCardSize
	} from '#lib/stores/homeCards.svelte.ts';
	import { ownsJob } from '#lib/home/cardJobs.ts';
	import { isRefreshing, refreshCard } from '#lib/home/fetchedCards.svelte.ts';
	import { selectJob } from '#lib/stores/jobsTabSelection.svelte.ts';
	import { setActiveTab } from '#lib/stores/activeTab.svelte.ts';
	import { isJobsLoaded, loadJobs } from '#lib/stores/jobs.svelte.ts';
	import { enqueue, getCurrentRun, getPendingQueue } from '#lib/agent/jobs/runner.svelte.ts';
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

	/** Grid rows are this tall; a card spans as many as its height needs. */
	const ROW = 4;
	const GAP = 12;

	/**
	 * Pack the grid like a masonry wall: each cell spans the rows its card's
	 * height needs, and dense placement fills the holes a short card leaves.
	 */
	function packRows(cell: HTMLElement) {
		if (typeof ResizeObserver === 'undefined') return;
		const card = cell.firstElementChild ?? cell;
		const observer = new ResizeObserver(() => {
			const height = card.getBoundingClientRect().height;
			cell.style.gridRowEnd = `span ${Math.ceil((height + GAP) / ROW)}`;
		});
		observer.observe(card);
		return { destroy: () => observer.disconnect() };
	}

	/**
	 * A drag to move a card, by its header. Pointer events rather than HTML
	 * drag and drop, which the webview's file drop takes over on Windows.
	 * It starts after a few pixels, so a click on the header stays a click.
	 */
	let drag = $state<{
		id: string;
		x: number;
		y: number;
		started: boolean;
		over: string | null;
	} | null>(null);

	function grab(e: PointerEvent, id: string) {
		if (e.button !== 0 || (e.target as HTMLElement).closest('button, a, input')) return;
		drag = { id, x: e.clientX, y: e.clientY, started: false, over: null };
	}

	function dragMove(e: PointerEvent) {
		if (!drag) return;
		if (!drag.started && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 5) return;
		e.preventDefault();
		const cell = document
			.elementFromPoint(e.clientX, e.clientY)
			?.closest<HTMLElement>('[data-card-id]');
		const over = cell?.dataset.cardId ?? null;
		drag = { ...drag, started: true, over: over === drag.id ? null : over };
	}

	function drop() {
		const done = drag;
		drag = null;
		if (done?.started && done.over) void moveCardTo(done.id, done.over);
	}

	/** ↻ reads a fetched card's source, or runs a judged card's job now. */
	function refresher(card: HomeCard, type: CardType | undefined): (() => void) | undefined {
		if (type?.fetch) return () => void refreshCard(card);
		const jobId = card.job_id;
		if (type?.kind === 'judged' && jobId !== null) return () => void enqueue(jobId, 'manual');
		return undefined;
	}

	/** A judged card's job is running or queued: its ↻ spins. */
	function jobBusy(jobId: number | null): boolean {
		if (jobId === null) return false;
		const run = getCurrentRun();
		if (run?.jobId === jobId && run.status === 'running') return true;
		return getPendingQueue().some((q) => q.jobId === jobId);
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

<svelte:window
	onpointermove={dragMove}
	onpointerup={drop}
	onkeydown={(e) => {
		if (drag && e.key === 'Escape') drag = null;
	}}
/>

<div class="home">
	<div class="toolbar">
		<SummaryBand {cards} />
		<AddCardMenu />
	</div>

	{#if isHomeCardsLoaded() && cards.length === 0}
		<p class="empty">No cards. Add one to see it here.</p>
	{/if}

	<div class="grid" class:dragging={drag?.started}>
		{#each cards as card, i (card.id)}
			{@const type = getCardType(card.card_type)}
			<!-- A pinned card whose job was deleted can only be removed. -->
			{@const orphan = type?.kind === 'pinned' && card.job_id === null}
			{@const arrangeable = type !== undefined && !orphan}
			<div
				class="cell"
				class:wide={card.size === 'wide'}
				class:lifted={drag?.started && drag.id === card.id}
				class:target={drag?.over === card.id}
				data-card-id={card.id}
				use:packRows
			>
				<CardFrame
					title={type ? (type.title?.(card) ?? type.label) : 'Unknown card'}
					size={card.size === 'wide' ? 'wide' : 'normal'}
					canMoveUp={i > 0}
					canMoveDown={i < cards.length - 1}
					{arrangeable}
					ongrab={arrangeable && cards.length > 1 ? (e) => grab(e, card.id) : undefined}
					onmove={(dir) => void moveCard(card.id, dir)}
					onresize={(size) => void setCardSize(card.id, size)}
					onrefresh={refresher(card, type)}
					refreshing={isRefreshing(card.id) || jobBusy(card.job_id)}
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
			</div>
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
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		margin-bottom: 12px;
	}

	/* Rows are 4px (ROW); packRows spans each cell over enough of them, and
	   its card keeps 12px (GAP) below it in place of a row gap. */
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
		grid-auto-rows: 4px;
		grid-auto-flow: row dense;
		column-gap: 12px;
		align-items: start;
	}

	.grid.dragging {
		cursor: grabbing;
		user-select: none;
	}

	.cell {
		min-width: 0;
	}

	.cell.wide {
		grid-column: span 2;
	}

	.cell.lifted {
		opacity: 0.5;
	}

	.cell.target > :global(.card) {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	@media (max-width: 700px) {
		.grid {
			grid-template-columns: 1fr;
		}

		.cell.wide {
			grid-column: auto;
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
