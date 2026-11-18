<script lang="ts">
	/**
	 * The chats of one of the owner's other computers, under this computer's
	 * in the conversation list: live while it's connected, greyed as last seen
	 * while it's offline. Opening one carries it on in the Chat view; it runs
	 * there (plan/instance-sync/).
	 */
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import {
		deleteRemoteChat,
		openRemoteChat,
		RemoteChatSource,
		renameRemoteChat
	} from '#lib/peers/remoteChat.svelte.ts';
	import { listedChats, type ListedChat, type PeerView } from '#lib/peers/store.svelte.ts';
	import { getActiveChatSource } from '#lib/stores/activeChatSource.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { peer }: { peer: PeerView } = $props();

	const chats = $derived(listedChats(peer));
	const offline = $derived(!peer.online);
	const activeId = $derived.by(() => {
		const s = getActiveChatSource();
		return s instanceof RemoteChatSource && s.view === peer ? s.chatId : null;
	});

	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	let deleting = $state<ListedChat | null>(null);

	/** What a row's dot shows, as the web page marks it. */
	function markOf(c: ListedChat): { kind: string; title: string } | null {
		if (c.waiting) return { kind: 'queued', title: 'Waiting' };
		if (c.busy) return { kind: 'running', title: 'Writing' };
		if (c.unread) return { kind: 'unread', title: 'New' };
		return null;
	}

	function act(what: string, run: () => Promise<unknown>): void {
		void run().catch((e: unknown) =>
			showToast(`Couldn't ${what}: ${errMessage(e)}`, { kind: 'error' })
		);
	}

	function open(c: ListedChat): void {
		if (c.offline) {
			showToast(`${peer.config.name} is offline.`);
			return;
		}
		act('open that chat', () => openRemoteChat(peer, c.id));
	}

	function finishRename(): void {
		const id = renamingId;
		const title = renameText.trim();
		renamingId = null;
		if (id && title) act('rename it', () => renameRemoteChat(peer, id, title));
	}
</script>

<section class="peer" aria-label="On {peer.config.name}">
	<h4
		class="heading"
		title={offline
			? `${peer.config.name} can't be reached: its chats as last seen.`
			: `Chats on ${peer.config.name}. They run there, with its model and memory.`}
	>
		On {peer.config.name}{#if offline}<span class="offline"> · offline</span>{/if}
	</h4>
	{#each chats as c (c.id)}
		<!-- svelte-ignore a11y_click_events_have_key_events -->
		<!-- svelte-ignore a11y_no_static_element_interactions -->
		<div
			class="conversation-item"
			class:active={c.id === activeId}
			class:offline={c.offline}
			onclick={() => open(c)}
			ondblclick={(e) => {
				e.stopPropagation();
				if (c.offline) return;
				renamingId = c.id;
				renameText = c.title;
			}}
		>
			{#if renamingId === c.id}
				<input
					class="rename-input"
					type="text"
					aria-label="Chat name"
					bind:value={renameText}
					onblur={finishRename}
					onkeydown={(e) => {
						if (e.key === 'Enter') finishRename();
						if (e.key === 'Escape') renamingId = null;
					}}
					onclick={(e) => e.stopPropagation()}
				/>
			{:else}
				{@const mark = markOf(c)}
				{#if mark}
					<span class="mark {mark.kind}" data-mark={mark.kind} title={mark.title}></span>
				{/if}
				<span class="conv-title" title={c.title}>{c.title}</span>
			{/if}
			{#if !c.offline}
				<button
					class="delete-btn"
					title="Delete this chat on {peer.config.name}"
					aria-label="Delete {c.title}"
					onclick={(e) => {
						e.stopPropagation();
						deleting = c;
					}}>&times;</button
				>
			{/if}
		</div>
	{/each}
</section>

{#if deleting}
	<ConfirmDialog
		open
		title="Delete conversation?"
		message={`"${deleting.title}" will be permanently deleted on ${peer.config.name}.`}
		onconfirm={() => {
			const id = deleting!.id;
			deleting = null;
			act('delete it', () => deleteRemoteChat(peer, id));
		}}
		oncancel={() => (deleting = null)}
	/>
{/if}

<style>
	.peer {
		margin-top: 10px;
	}

	.heading {
		margin: 0;
		padding: 6px 10px 4px;
		color: var(--text-secondary);
		font-size: 0.72rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.offline {
		font-weight: 500;
		text-transform: none;
		letter-spacing: 0;
	}

	/* As ConversationSidebar's own rows. */
	.conversation-item {
		display: flex;
		align-items: center;
		width: 100%;
		padding: 8px 10px;
		border-radius: 6px;
		cursor: pointer;
		font-size: 0.85rem;
	}

	.conversation-item:hover {
		background: var(--bg-primary);
	}

	.conversation-item.active {
		background: var(--bg-primary);
		font-weight: 500;
		box-shadow: inset 2px 0 0 var(--accent);
	}

	.conversation-item.offline {
		opacity: 0.5;
	}

	.conv-title {
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.mark {
		width: 7px;
		height: 7px;
		margin-right: 6px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.mark.running {
		background: var(--accent);
	}

	.mark.queued {
		border: 1.5px solid var(--warning);
		box-sizing: border-box;
	}

	.mark.unread {
		background: var(--accent);
	}

	.rename-input {
		flex: 1;
		font-size: 0.85rem;
	}

	.delete-btn {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-secondary);
		cursor: pointer;
		opacity: 0;
	}

	.conversation-item:hover .delete-btn {
		opacity: 1;
	}
</style>
