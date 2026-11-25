<script lang="ts">
	/**
	 * One notebook: its title, tags and pin, then its cards in order with a
	 * way to add a card between any two. Cards drag to reorder.
	 */
	import { tick } from 'svelte';
	import type { Snippet } from 'svelte';
	import CardFrame from '#lib/components/notebooks/CardFrame.svelte';
	import AddCardMenu from '#lib/components/notebooks/AddCardMenu.svelte';
	import UnavailableCard from '#lib/components/notebooks/cards/UnavailableCard.svelte';
	import { cardKind } from '#lib/notebooks/cardKinds.ts';
	import { addFilesAsCards } from '#lib/notebooks/files.ts';
	import { fileDropTarget } from '#lib/utils/fileDrop.ts';
	import { startDragAutoScroll } from '#lib/utils/dragAutoScroll.ts';
	import type { NotebookCard, NotebookDetail } from '#lib/notebooks/api.ts';
	import {
		getFocusCard,
		moveCard,
		patchNotebook,
		trashNotebook
	} from '#lib/stores/notebooks.svelte.ts';

	interface Props {
		notebook: NotebookDetail;
		/** Kinds whose adding needs more than a click (a file picker). */
		onpickkind?: (kind: string, after: string | null) => void;
		/** Extra notebook-menu items (Export…, Check links…). */
		menuItems?: { label: string; run: () => void }[];
		/** Per-card extras: its badge and menu items. */
		cardBadge?: Snippet<[NotebookCard]>;
		cardMenu?: (card: NotebookCard) => { label: string; run: () => void }[];
		/** Something above the cards (a link-check summary). */
		banner?: Snippet;
	}

	let { notebook, onpickkind, menuItems = [], cardBadge, cardMenu, banner }: Props = $props();

	const nb = $derived(notebook.notebook);
	const cards = $derived(notebook.cards);

	let title = $state('');
	let tags = $state('');
	$effect(() => {
		title = nb.title;
		tags = nb.tags.join(', ');
	});

	let menuOpen = $state(false);
	let flashId = $state<string | null>(null);
	let dragId: string | null = null;
	let dropTarget = $state<string | null>(null);
	let stopAutoScroll: (() => void) | null = null;
	let viewEl: HTMLDivElement | undefined = $state();

	function endDrag() {
		stopAutoScroll?.();
		stopAutoScroll = null;
		dragId = null;
		dropTarget = null;
	}

	$effect(() => () => stopAutoScroll?.());

	function saveTitle() {
		const t = title.trim();
		if (t && t !== nb.title) void patchNotebook(nb.id, { title: t });
		else title = nb.title;
	}

	function saveTags() {
		const list = tags
			.split(',')
			.map((t) => t.trim())
			.filter(Boolean);
		if (list.join(',') !== nb.tags.join(',')) void patchNotebook(nb.id, { tags: list });
	}

	// Scroll to and flash a card that was just added or linked to.
	$effect(() => {
		const focus = getFocusCard();
		if (!focus || !cards.some((c) => c.id === focus.id)) return;
		void tick().then(() => {
			const el = document.getElementById(`nb-card-${focus.id}`);
			el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
			if (focus.rowId) {
				const row = document.getElementById(`nb-row-${focus.rowId}`);
				row?.scrollIntoView({ block: 'center', behavior: 'smooth' });
				row?.classList.add('row-flash');
				setTimeout(() => row?.classList.remove('row-flash'), 1600);
			}
			flashId = focus.id;
			setTimeout(() => {
				if (flashId === focus.id) flashId = null;
			}, 1200);
		});
	});

	let fileOver = $state(false);

	/** Files dropped on the notebook land after the card under the pointer. */
	function onFiles(paths: string[], at: { x: number; y: number }) {
		let after: string | null = null;
		for (const c of cards) {
			const el = document.getElementById(`nb-card-${c.id}`);
			if (el && el.getBoundingClientRect().top <= at.y) after = c.id;
		}
		void addFilesAsCards(paths, after);
	}

	function onDrop(targetId: string) {
		const id = dragId;
		endDrag();
		if (!id || id === targetId) return;
		void moveCard(id, targetId);
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (menuOpen && e.key === 'Escape') menuOpen = false;
	}}
/>

<div
	class="view"
	bind:this={viewEl}
	class:file-over={fileOver}
	use:fileDropTarget={{ onFiles, onDragChange: (o) => (fileOver = o) }}
>
	<header>
		<div class="title-row">
			<input
				class="title"
				bind:value={title}
				aria-label="Notebook title"
				onblur={saveTitle}
				onkeydown={(e) => {
					if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
				}}
			/>
			<button
				class="icon"
				class:on={nb.pinned}
				onclick={() => void patchNotebook(nb.id, { pinned: !nb.pinned })}
				aria-pressed={nb.pinned}
				title={nb.pinned ? 'Unpin' : 'Pin to the top of the list'}
			>
				📌
			</button>
			<div class="menu-host">
				<button
					class="icon"
					onclick={() => (menuOpen = !menuOpen)}
					aria-label="Notebook options"
					aria-haspopup="menu"
					aria-expanded={menuOpen}
				>
					⋯
				</button>
				{#if menuOpen}
					<div class="menu" role="menu" aria-label="Notebook options">
						{#each menuItems as item (item.label)}
							<button
								role="menuitem"
								onclick={() => {
									menuOpen = false;
									item.run();
								}}
							>
								{item.label}
							</button>
						{/each}
						<button
							role="menuitem"
							onclick={() => {
								menuOpen = false;
								void trashNotebook(nb.id);
							}}
						>
							Delete notebook
						</button>
					</div>
				{/if}
			</div>
		</div>
		<input
			class="tags"
			bind:value={tags}
			placeholder="Tags, separated by commas"
			aria-label="Tags"
			title="Tags filter the notebook list"
			onblur={saveTags}
			onkeydown={(e) => {
				if (e.key === 'Enter') (e.currentTarget as HTMLInputElement).blur();
			}}
		/>
	</header>

	{#if banner}{@render banner()}{/if}

	<div class="cards">
		{#each cards as card, i (card.id)}
			{@const def = cardKind(card.kind)}
			<!-- svelte-ignore a11y_no_static_element_interactions -->
			<div
				class="slot"
				class:drop={dropTarget === card.id}
				ondragover={(e) => {
					if (!dragId) return;
					e.preventDefault();
					dropTarget = card.id;
				}}
				ondragleave={() => {
					if (dropTarget === card.id) dropTarget = null;
				}}
				ondrop={(e) => {
					e.preventDefault();
					onDrop(card.id);
				}}
			>
				<CardFrame
					{card}
					canMoveUp={i > 0}
					canMoveDown={i < cards.length - 1}
					flash={flashId === card.id}
					menuItems={cardMenu?.(card) ?? []}
					ondragstart={(e) => {
						dragId = card.id;
						// Not text/plain: a text field would take the id as a drop.
						if (e.dataTransfer) {
							e.dataTransfer.setData('application/x-haruspex-card', card.id);
							e.dataTransfer.effectAllowed = 'move';
						}
						stopAutoScroll?.();
						if (viewEl) stopAutoScroll = startDragAutoScroll(viewEl);
					}}
					ondragend={endDrag}
				>
					{#snippet badge()}
						{#if cardBadge}{@render cardBadge(card)}{/if}
					{/snippet}
					{#if def}
						<def.component {card} />
					{:else}
						<UnavailableCard {card} />
					{/if}
				</CardFrame>
			</div>
			{#if i < cards.length - 1}
				<AddCardMenu after={card.id} compact onpick={onpickkind} />
			{/if}
		{/each}
		<AddCardMenu after={null} onpick={onpickkind} />
	</div>
</div>

<style>
	.view.file-over {
		outline: 2px dashed var(--accent);
		outline-offset: -6px;
	}

	.view {
		flex: 1;
		min-width: 0;
		overflow-y: auto;
		padding: 16px 24px 48px;
	}

	header {
		margin: 0 0 12px;
	}

	.title-row {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.title {
		flex: 1;
		min-width: 0;
		border: none;
		background: none;
		color: var(--text-primary);
		font-size: 1.4rem;
		font-weight: 700;
		padding: 2px 4px;
		border-radius: 4px;
	}

	.title:focus,
	.tags:focus {
		outline: 1px solid var(--border-strong);
		background: var(--bg-input);
	}

	.tags {
		width: 100%;
		box-sizing: border-box;
		border: none;
		background: none;
		color: var(--text-secondary);
		font-size: 0.85rem;
		padding: 2px 4px;
		border-radius: 4px;
	}

	.icon {
		border: none;
		background: none;
		cursor: pointer;
		font-size: 1rem;
		padding: 4px 6px;
		border-radius: 4px;
		color: var(--text-secondary);
		opacity: 0.6;
	}

	.icon.on,
	.icon:hover {
		opacity: 1;
		background: var(--bg-secondary);
	}

	.menu-host {
		position: relative;
	}

	.menu {
		position: absolute;
		top: calc(100% + 4px);
		right: 0;
		z-index: 20;
		display: flex;
		flex-direction: column;
		min-width: 170px;
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

	.cards {
		display: flex;
		flex-direction: column;
		gap: 4px;
		margin: 0;
	}

	.slot.drop {
		border-bottom: 2px solid var(--accent);
	}

	:global(.row-flash) {
		background: var(--accent-soft) !important;
	}
</style>
