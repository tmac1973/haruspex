<script lang="ts">
	/**
	 * Left-rail conversation list with inline rename, per-row delete,
	 * "+ New Chat" button, collapse toggle, and a "Clear all" footer for this
	 * computer's chats. Below them, each of the owner's other computers'
	 * chats (plan/instance-sync/), in its colour.
	 *
	 * Reads from and writes back to the chat store directly — no props,
	 * no emitted events. The root route mounts this once and forgets it.
	 *
	 * The filter keeps chats whose title has every word typed, or whose
	 * messages match (each computer's own full-text index). Select turns on a
	 * checkbox per row, shift-click for a range, to delete many at once.
	 * Dragging the right edge sets the width (Settings' `chatSidebarWidth`).
	 *
	 * Rename UX: click the pencil (visible on row hover / focus-within)
	 * or double-click a row to enter rename mode, Enter to commit,
	 * Escape (or blur) to cancel. Active row is highlighted.
	 */
	import {
		clearAllConversations,
		createConversation,
		deleteConversation,
		getActiveConversationId,
		getConversations,
		getRun,
		renameConversation,
		setActiveConversation,
		type Conversation
	} from '#lib/stores/chat.svelte.ts';
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import PeerChatSection from '#lib/components/PeerChatSection.svelte';
	import { listedChats, peerViews, type PeerView } from '#lib/peers/store.svelte.ts';
	import { closeRemoteChat, deleteRemoteChat } from '#lib/peers/remoteChat.svelte.ts';
	import { getActiveChatSource } from '#lib/stores/activeChatSource.svelte.ts';
	import { localChatSource } from '#lib/stores/chat.svelte.ts';
	import { searchLocalChats, searchPeerChats, titleMatches } from '#lib/chat/search.ts';
	import { getSettings, updateSettings } from '#lib/stores/settings.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { startDragResize } from '#lib/utils/dragResize.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let collapsed = $state(false);
	let renamingId = $state<string | null>(null);
	let renameText = $state('');

	const MIN_WIDTH = 200;
	const MAX_WIDTH = 640;
	const clampWidth = (w: number) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, w));
	let width = $state(clampWidth(getSettings().chatSidebarWidth));

	function startResize(event: MouseEvent) {
		startDragResize(event, {
			width,
			widens: 'right',
			clamp: clampWidth,
			onResize: (w) => (width = w),
			onDone: (w) => updateSettings({ chatSidebarWidth: w })
		});
	}

	// Pending destructive action awaiting ConfirmDialog: a single
	// conversation (id + title for the dialog copy), the clear-all sweep of
	// this computer's, or the selected chats.
	type PendingDelete =
		{ kind: 'one'; id: string; title: string } | { kind: 'all' } | { kind: 'selected' };
	let pendingDelete = $state<PendingDelete | null>(null);

	const conversations = $derived(getConversations());
	/** The row on screen: none of this computer's while another's chat shows. */
	const activeId = $derived(
		getActiveChatSource() === localChatSource ? getActiveConversationId() : null
	);
	/** Other computers with chats to list, or connected. */
	const peers = $derived(peerViews().filter((p) => p.online || listedChats(p).length > 0));

	// --- the filter ---------------------------------------------------------

	let filter = $state('');
	/** This computer's chats whose messages match the filter. */
	let localHits = $state<string[]>([]);
	/** Each other computer's matches; absent when it can't search (titles only). */
	let peerHits = $state<Record<string, string[]>>({});

	// What was said, searched once the typing settles.
	$effect(() => {
		const query = filter.trim();
		const views = peers;
		localHits = [];
		peerHits = {};
		if (!query) return;
		let current = true;
		const timer = setTimeout(() => {
			void searchLocalChats(query).then((ids) => {
				if (current) localHits = ids;
			});
			for (const view of views) {
				void searchPeerChats(view, query).then((ids) => {
					if (current && ids) peerHits = { ...peerHits, [view.id]: ids };
				});
			}
		}, 250);
		return () => {
			current = false;
			clearTimeout(timer);
		};
	});

	const shownLocal = $derived(
		filter.trim()
			? conversations.filter((c) => titleMatches(c.title, filter) || localHits.includes(c.id))
			: conversations
	);

	function shownFor(peer: PeerView) {
		const chats = listedChats(peer);
		if (!filter.trim()) return chats;
		const hits = peerHits[peer.id] ?? [];
		return chats.filter((c) => titleMatches(c.title, filter) || hits.includes(c.id));
	}

	const shownPeers = $derived(
		peers
			.map((peer) => ({ peer, chats: shownFor(peer) }))
			.filter((p) => !filter.trim() || p.chats.length)
	);

	// --- selecting ----------------------------------------------------------

	let selecting = $state(false);
	/** Selected rows by key: `local:<id>`, or `<instance id>:<id>` for another computer's. */
	let selected = $state<Record<string, true>>({});
	let lastToggled = $state<string | null>(null);

	/** Every row on screen that can be selected, in order. */
	const selectable = $derived([
		...shownLocal.map((c) => `local:${c.id}`),
		...shownPeers.flatMap(({ peer, chats }) =>
			chats.filter((c) => !c.offline).map((c) => `${peer.id}:${c.id}`)
		)
	]);
	const selectedKeys = $derived(selectable.filter((k) => selected[k]));

	/** Toggle `key`; with shift, set every row from the last one toggled to it alike. */
	function toggle(key: string, range: boolean) {
		const on = !selected[key];
		const from = lastToggled ? selectable.indexOf(lastToggled) : -1;
		const to = selectable.indexOf(key);
		const keys =
			range && from >= 0 && to >= 0
				? selectable.slice(Math.min(from, to), Math.max(from, to) + 1)
				: [key];
		const next = { ...selected };
		for (const k of keys) {
			if (on) next[k] = true;
			else delete next[k];
		}
		selected = next;
		lastToggled = key;
	}

	function stopSelecting() {
		selecting = false;
		selected = {};
		lastToggled = null;
	}

	function selectAllShown() {
		selected = Object.fromEntries(selectable.map((k) => [k, true as const]));
	}

	/** How many selected rows each computer has, this one first. */
	const selectedByComputer = $derived.by(() => {
		const counts: { name: string; n: number }[] = [];
		const local = selectedKeys.filter((k) => k.startsWith('local:')).length;
		if (local) counts.push({ name: 'this computer', n: local });
		for (const { peer } of shownPeers) {
			const n = selectedKeys.filter((k) => k.startsWith(`${peer.id}:`)).length;
			if (n) counts.push({ name: peer.config.name, n });
		}
		return counts;
	});

	async function deleteSelected() {
		const keys = selectedKeys;
		stopSelecting();
		const failures: string[] = [];
		for (const key of keys) {
			const at = key.indexOf(':');
			const where = key.slice(0, at);
			const id = key.slice(at + 1);
			try {
				if (where === 'local') await deleteConversation(id);
				else {
					const view = peers.find((p) => p.id === where);
					if (view) await deleteRemoteChat(view, id);
				}
			} catch (e) {
				failures.push(errMessage(e));
			}
		}
		if (failures.length) {
			showToast(`Couldn't delete ${failures.length} of them: ${failures[0]}`, { kind: 'error' });
		}
	}

	// --- the dialogs --------------------------------------------------------

	const deleteDialog = $derived.by(() => {
		if (pendingDelete === null) return null;
		if (pendingDelete.kind === 'all') {
			return {
				title: 'Delete all conversations on this computer?',
				message:
					"This computer's chat history will be permanently deleted. Your other computers' chats stay.",
				confirmLabel: 'Delete all'
			};
		}
		if (pendingDelete.kind === 'selected') {
			const parts = selectedByComputer.map((c) => `${c.n} on ${c.name}`).join(', ');
			return {
				title: `Delete ${selectedKeys.length} conversations?`,
				message: `${parts}: permanently deleted.`,
				confirmLabel: 'Delete'
			};
		}
		return {
			title: 'Delete conversation?',
			message: `"${pendingDelete.title}" will be permanently deleted.`,
			confirmLabel: 'Delete'
		};
	});

	function confirmPendingDelete() {
		if (!pendingDelete) return;
		if (pendingDelete.kind === 'one') void deleteConversation(pendingDelete.id);
		else if (pendingDelete.kind === 'selected') void deleteSelected();
		else void clearAllConversations();
		pendingDelete = null;
	}

	/** Show one of this computer's chats, leaving another's; or select it. */
	function openLocal(id: string, event: MouseEvent) {
		if (selecting) {
			toggle(`local:${id}`, event.shiftKey);
			return;
		}
		closeRemoteChat();
		void setActiveConversation(id);
	}

	/** What a row's dot shows: a turn working, one waiting, or an answer not yet seen. */
	function markOf(conv: Conversation): { kind: string; title: string } | null {
		const run = getRun(conv.id);
		if (run.queuedForStartup) return { kind: 'queued', title: 'Waiting for the model to start' };
		if (run.waitingForSlot) return { kind: 'queued', title: 'Waiting for another turn to finish' };
		if (run.generating || run.compacting) return { kind: 'running', title: 'Working' };
		if (conv.unread) return { kind: 'unread', title: 'Finished while you were elsewhere' };
		return null;
	}

	function startRename(id: string, currentTitle: string) {
		renamingId = id;
		renameText = currentTitle;
	}

	function finishRename() {
		if (renamingId && renameText.trim()) {
			void renameConversation(renamingId, renameText.trim());
		}
		renamingId = null;
	}

	function handleRenameKeydown(e: KeyboardEvent) {
		if (e.key === 'Enter') {
			e.preventDefault();
			finishRename();
		} else if (e.key === 'Escape') {
			renamingId = null;
		}
	}
</script>

<aside class="sidebar" class:collapsed style={collapsed ? undefined : `width: ${width}px`}>
	<div class="sidebar-header">
		{#if !collapsed}
			<button
				class="new-chat-btn"
				onclick={() => {
					closeRemoteChat();
					createConversation();
				}}
			>
				+ New Chat
			</button>
		{/if}
		{#if !collapsed}
			<button
				class="select-btn"
				class:active={selecting}
				aria-pressed={selecting}
				title="Pick several chats to delete at once (shift-click for a range)"
				onclick={() => (selecting ? stopSelecting() : (selecting = true))}
			>
				Select
			</button>
		{/if}
		<button
			class="collapse-btn"
			onclick={() => (collapsed = !collapsed)}
			title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
		>
			{collapsed ? '▶' : '◀'}
		</button>
	</div>
	{#if !collapsed}
		<div class="filter-row">
			<input
				class="filter"
				type="search"
				placeholder="Search chats"
				aria-label="Search chats"
				title="Titles with every word you type, and chats where they were said, on each computer"
				bind:value={filter}
				onkeydown={(e) => {
					if (e.key === 'Escape') filter = '';
				}}
			/>
		</div>
		<div class="conversation-list thin-scroll">
			{#if filter.trim() && shownLocal.length === 0 && shownPeers.length === 0}
				<p class="empty">No chats match.</p>
			{/if}
			{#each shownLocal as conv (conv.id)}
				<!-- svelte-ignore a11y_click_events_have_key_events -->
				<!-- svelte-ignore a11y_no_static_element_interactions -->
				<div
					class="conversation-item"
					class:active={conv.id === activeId}
					onclick={(e) => openLocal(conv.id, e)}
					ondblclick={(e) => {
						e.stopPropagation();
						if (!selecting) startRename(conv.id, conv.title);
					}}
				>
					{#if selecting}
						<input
							class="select-box"
							type="checkbox"
							aria-label="Select {conv.title}"
							checked={!!selected[`local:${conv.id}`]}
							onclick={(e) => {
								e.stopPropagation();
								toggle(`local:${conv.id}`, e.shiftKey);
							}}
						/>
					{/if}
					{#if renamingId === conv.id}
						<input
							class="rename-input"
							type="text"
							bind:value={renameText}
							onblur={finishRename}
							onkeydown={handleRenameKeydown}
							onclick={(e) => e.stopPropagation()}
						/>
					{:else}
						{@const mark = markOf(conv)}
						{#if mark}
							<span
								class="mark {mark.kind}"
								data-mark={mark.kind}
								title={mark.title}
								aria-label={mark.title}
							></span>
						{/if}
						<span class="conv-title" class:unread={mark?.kind === 'unread'} title={conv.title}>
							{conv.title}
						</span>
						{#if !selecting}
							<button
								class="rename-btn"
								onclick={(e) => {
									e.stopPropagation();
									startRename(conv.id, conv.title);
								}}
								aria-label="Rename conversation"
								title="Rename"
							>
								&#9998;
							</button>
						{/if}
					{/if}
					{#if !selecting}
						<button
							class="delete-btn"
							onclick={(e) => {
								e.stopPropagation();
								pendingDelete = { kind: 'one', id: conv.id, title: conv.title };
							}}
							title="Delete conversation"
						>
							&times;
						</button>
					{/if}
				</div>
			{/each}
			{#each shownPeers as { peer, chats } (peer.id)}
				<PeerChatSection
					{peer}
					{chats}
					{selecting}
					isSelected={(id) => !!selected[`${peer.id}:${id}`]}
					ontoggle={(id, range) => toggle(`${peer.id}:${id}`, range)}
				/>
			{/each}
		</div>
		{#if selecting}
			<div class="sidebar-footer select-footer">
				<button class="link-btn" onclick={selectAllShown}>Select all shown</button>
				<button
					class="delete-selected-btn"
					disabled={selectedKeys.length === 0}
					onclick={() => (pendingDelete = { kind: 'selected' })}
				>
					Delete {selectedKeys.length}
				</button>
				<button class="link-btn" onclick={stopSelecting}>Cancel</button>
			</div>
		{:else if conversations.length > 0}
			<div class="sidebar-footer">
				<button
					class="clear-all-btn"
					title="Deletes every chat on this computer; other computers' chats stay"
					onclick={() => (pendingDelete = { kind: 'all' })}
				>
					Clear all on this computer
				</button>
			</div>
		{/if}
		<button
			class="resize-handle"
			onmousedown={startResize}
			aria-label="Drag to resize"
			title="Drag to resize"
		></button>
	{/if}
</aside>

{#if deleteDialog}
	<ConfirmDialog
		open
		title={deleteDialog.title}
		message={deleteDialog.message}
		confirmLabel={deleteDialog.confirmLabel}
		onconfirm={confirmPendingDelete}
		oncancel={() => (pendingDelete = null)}
	/>
{/if}

<style>
	.sidebar {
		position: relative;
		width: 260px;
		border-right: 1px solid var(--border);
		display: flex;
		flex-direction: column;
		flex-shrink: 0;
		background: var(--bg-secondary);
	}
	.sidebar.collapsed {
		width: 40px;
	}
	.sidebar-header {
		display: flex;
		align-items: center;
		padding: 8px;
		gap: 4px;
		border-bottom: 1px solid var(--border);
	}
	.new-chat-btn {
		flex: 1;
		padding: 6px 12px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-primary);
		color: var(--text-primary);
		cursor: pointer;
		font-size: 0.85rem;
		text-align: left;
	}
	.new-chat-btn:hover {
		background: var(--bg-secondary);
	}
	.collapse-btn {
		background: none;
		border: none;
		cursor: pointer;
		padding: 4px 6px;
		font-size: 0.7rem;
		color: var(--text-secondary);
	}
	.conversation-list {
		flex: 1;
		overflow-x: hidden;
		overflow-y: auto;
		scrollbar-gutter: stable;
		padding: 4px 8px 4px 4px;
	}
	.conversation-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 8px 10px;
		border: none;
		border-radius: 6px;
		background: none;
		cursor: pointer;
		text-align: left;
		font-size: 0.85rem;
		color: var(--text-primary);
		gap: 4px;
	}
	.conversation-item:hover {
		background: var(--bg-primary);
	}
	.conversation-item.active {
		background: var(--bg-primary);
		font-weight: 500;
		/* Inset accent edge (not border-left) so the row width doesn't shift. */
		box-shadow: inset 2px 0 0 var(--accent);
	}
	.conv-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.conv-title.unread {
		font-weight: 600;
	}

	/* Same dots as the Code tab strip: working, waiting, and unread. */
	.mark {
		width: 7px;
		height: 7px;
		margin-right: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.mark.running {
		background: var(--accent);
		animation: mark-pulse 1.2s ease-in-out infinite;
	}

	/* Hollow: waiting its turn rather than working. */
	.mark.queued {
		border: 1.5px solid var(--warning);
		box-sizing: border-box;
	}

	.mark.unread {
		background: var(--accent);
	}

	@keyframes mark-pulse {
		50% {
			opacity: 0.35;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.mark.running {
			animation: none;
		}
	}
	/* The rename pencil and delete × share the opacity-on-hover treatment:
	   invisible until the row is hovered — or contains keyboard focus, so
	   tabbing users can see what they've reached. */
	.rename-btn,
	.delete-btn {
		background: none;
		border: none;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 1rem;
		padding: 0 4px;
		margin-right: 2px;
		opacity: 0;
		transition: opacity 0.15s;
		flex-shrink: 0;
	}
	.rename-btn {
		font-size: 0.85rem;
	}
	.conversation-item:hover .rename-btn,
	.conversation-item:focus-within .rename-btn,
	.conversation-item:hover .delete-btn,
	.conversation-item:focus-within .delete-btn {
		opacity: 1;
	}
	.rename-btn:hover {
		color: var(--text-primary);
	}
	.delete-btn:hover {
		color: var(--error-text);
	}
	.rename-input {
		flex: 1;
		padding: 2px 6px;
		border: 1px solid var(--accent);
		border-radius: 4px;
		font-size: 0.85rem;
		background: var(--bg-primary);
		color: var(--text-primary);
		outline: none;
		min-width: 0;
	}
	.sidebar-footer {
		padding: 8px;
		border-top: 1px solid var(--border);
	}
	.select-footer {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.select-btn {
		padding: 4px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font-size: 0.75rem;
		cursor: pointer;
	}
	.select-btn.active {
		border-color: var(--accent);
		color: var(--text-primary);
	}
	.filter-row {
		padding: 6px 8px 2px;
	}
	.filter {
		width: 100%;
		box-sizing: border-box;
		padding: 5px 8px;
		font-size: 0.8rem;
	}
	.empty {
		margin: 8px 6px;
		font-size: 0.8rem;
		color: var(--text-secondary);
	}
	.select-box {
		margin: 0 6px 0 0;
		flex-shrink: 0;
	}
	.link-btn {
		background: none;
		border: none;
		padding: 4px 2px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		cursor: pointer;
	}
	.link-btn:hover {
		color: var(--text-primary);
	}
	.delete-selected-btn {
		margin-left: auto;
		padding: 5px 10px;
		border: 1px solid var(--error-text);
		border-radius: 6px;
		background: none;
		color: var(--error-text);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.delete-selected-btn:disabled {
		opacity: 0.4;
		cursor: default;
	}
	.resize-handle {
		position: absolute;
		top: 0;
		right: -3px;
		width: 6px;
		height: 100%;
		padding: 0;
		border: none;
		background: none;
		cursor: col-resize;
		z-index: 2;
	}
	/* As the Code tab's session list. */
	.resize-handle:hover,
	.resize-handle:active {
		background: color-mix(in srgb, var(--accent) 40%, transparent);
	}
	.clear-all-btn {
		width: 100%;
		padding: 6px;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-secondary);
		font-size: 0.8rem;
		cursor: pointer;
	}
	.clear-all-btn:hover {
		color: var(--error-text);
		background: var(--error-bg);
	}
</style>
