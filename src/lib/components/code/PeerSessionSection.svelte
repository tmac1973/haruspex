<script lang="ts">
	/**
	 * The Code sessions of one of the owner's other computers, under the
	 * local ones in the session list: live while it's connected, greyed as
	 * last seen while it's offline. Opening one shows it in the Code pane,
	 * where it runs there (plan/archive/instance-sync/). Right-click renames or
	 * deletes one there, as for this computer's sessions.
	 */
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import { rowMenu } from '#lib/actions/rowMenu.ts';
	import type { RowMenuItem } from '#lib/stores/rowMenu.svelte.ts';
	import { focusOnMount } from '#lib/utils/focusOnMount.ts';
	import { folderName, lastActive } from '#lib/code/sessionList.ts';
	import {
		deleteRemoteSession,
		openRemoteSession,
		remoteViewId,
		renameRemoteSession
	} from '#lib/peers/remoteCodeSession.svelte.ts';
	import {
		listedSessions,
		sessionWaiting,
		sortListedSessions,
		type ListedSession,
		type PeerView
	} from '#lib/peers/store.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { titleMatches } from '#lib/chat/search.ts';
	import { peerColor } from '#lib/peers/color.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		peer,
		activeId,
		openIds,
		now,
		filter = ''
	}: {
		peer: PeerView;
		activeId: string | null;
		openIds: Set<string>;
		now: number;
		/** The sidebar's search: titles and folders with every word. */
		filter?: string;
	} = $props();

	const sessions = $derived(
		sortListedSessions(listedSessions(peer)).filter(
			(s) => !filter.trim() || titleMatches(`${label(s)} ${s.root}`, filter)
		)
	);
	const offline = $derived(!peer.online);

	function label(s: ListedSession): string {
		return s.title || folderName(s.root);
	}

	let renamingId = $state<string | null>(null);
	let renameText = $state('');
	let deleting = $state<ListedSession | null>(null);

	function act(what: string, run: () => Promise<unknown>): void {
		void run().catch((e: unknown) =>
			showToast(`Couldn't ${what}: ${errMessage(e)}`, { kind: 'error' })
		);
	}

	function startRename(s: ListedSession): void {
		renamingId = s.id;
		renameText = s.title;
	}

	function finishRename(): void {
		const id = renamingId;
		const title = renameText.trim();
		renamingId = null;
		const s = sessions.find((x) => x.id === id);
		if (id && s && title && title !== s.title) {
			act('rename it', () => renameRemoteSession(peer, id, title));
		}
	}

	/** Rename and delete reach the other computer, so an offline session has none. */
	function menuItems(s: ListedSession): RowMenuItem[] {
		if (s.offline) return [];
		return [
			{ label: 'Rename', run: () => startRename(s) },
			{
				label: 'Delete…',
				danger: true,
				title: `Delete this session on ${peer.config.name}`,
				run: () => (deleting = s)
			}
		];
	}

	async function open(s: ListedSession): Promise<void> {
		if (s.offline) {
			showToast(`${peer.config.name} is offline.`);
			return;
		}
		try {
			await openRemoteSession(peer, s.id);
		} catch (e) {
			showToast(`Couldn't open that session: ${errMessage(e)}`, { kind: 'error' });
		}
	}
</script>

<section class="peer" aria-label="On {peer.config.name}" style="--peer-color: {peerColor(peer.id)}">
	<h4
		class="heading"
		title={offline
			? `${peer.config.name} can't be reached: its sessions as last seen.`
			: `Sessions running on ${peer.config.name}. They run there, with its files and models.`}
	>
		On {peer.config.name}{#if offline}<span class="offline"> · offline</span>{/if}
	</h4>
	<ul>
		{#each sessions as s (s.id)}
			{@const id = remoteViewId(peer.id, s.id)}
			<li>
				{#if renamingId === s.id}
					<input
						class="rename"
						aria-label="Session name"
						use:focusOnMount
						onfocus={(e) => e.currentTarget.select()}
						bind:value={renameText}
						onblur={finishRename}
						onkeydown={(e) => {
							if (e.key === 'Enter') finishRename();
							if (e.key === 'Escape') renamingId = null;
						}}
					/>
				{:else}
					<button
						class="session"
						class:offline={s.offline}
						class:open={openIds.has(id)}
						class:active={id === activeId}
						aria-label={label(s)}
						title="{label(s)} — {s.root} on {peer.config.name}.{s.offline
							? ''
							: ' Right-click to rename or delete.'}"
						onclick={() => void open(s)}
						ondblclick={() => {
							if (!s.offline) startRename(s);
						}}
						use:rowMenu={() => menuItems(s)}
					>
						<span class="name">
							{label(s)}{#if !s.offline && sessionWaiting(peer, s.id)}<span
									class="waiting"
									data-testid="peer-waiting"
									title="Waiting for you: answer it here or on {peer.config.name}"
								>
									●
								</span>{/if}
						</span>
						<span class="meta">
							{folderName(s.root)}{s.updatedAt != null ? ` · ${lastActive(s.updatedAt, now)}` : ''}
						</span>
					</button>
				{/if}
			</li>
		{/each}
	</ul>
</section>

{#if deleting}
	<ConfirmDialog
		open
		title="Delete session?"
		message={`"${label(deleting)}" and its conversation will be deleted on ${peer.config.name}. Files in the folder, and any worktree, stay.`}
		onconfirm={() => {
			const id = deleting!.id;
			deleting = null;
			act('delete it', () => deleteRemoteSession(peer, id));
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
		/* The computer's colour, as on its rows and tabs. */
		border-left: 3px solid var(--peer-color);
		padding: 6px 6px 4px;
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

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.rename {
		width: calc(100% - 12px);
		margin: 2px 4px 2px 8px;
		padding: 3px 6px;
		font-size: 0.8rem;
		border: 1px solid var(--accent);
		border-radius: 4px;
		background: var(--bg-input);
		color: var(--text-primary);
		outline: none;
	}

	/* As the local rows in CodeSidebar. */
	.session {
		display: flex;
		flex-direction: column;
		gap: 1px;
		width: 100%;
		appearance: none;
		background: none;
		border: 0;
		border-left: 2px solid transparent;
		border-radius: 0 4px 4px 0;
		padding: 5px 8px;
		font-size: 0.8rem;
		color: var(--text-secondary);
		text-align: left;
		cursor: pointer;
	}

	.name,
	.meta {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.meta {
		font-size: 0.7rem;
		opacity: 0.8;
	}

	.session:hover {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	.session.open {
		color: var(--text-primary);
	}

	.session {
		border-left-color: color-mix(in srgb, var(--peer-color) 60%, transparent);
	}

	.session.active {
		background: var(--accent-soft);
		border-left-color: var(--peer-color);
		color: var(--text-primary);
	}

	.waiting {
		margin-left: 5px;
		font-size: 0.6rem;
		color: var(--warning);
	}

	.session.offline {
		opacity: 0.5;
	}
</style>
