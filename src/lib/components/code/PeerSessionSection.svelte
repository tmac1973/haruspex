<script lang="ts">
	/**
	 * The Code sessions of one of the owner's other computers, under the
	 * local ones in the session list: live while it's connected, greyed as
	 * last seen while it's offline. Opening one shows it in the Code pane,
	 * where it runs there (plan/instance-sync/).
	 */
	import { folderName, lastActive } from '#lib/code/sessionList.ts';
	import { openRemoteSession, remoteViewId } from '#lib/peers/remoteCodeSession.svelte.ts';
	import {
		listedSessions,
		sortListedSessions,
		type ListedSession,
		type PeerView
	} from '#lib/peers/store.svelte.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let {
		peer,
		activeId,
		openIds,
		now
	}: { peer: PeerView; activeId: string | null; openIds: Set<string>; now: number } = $props();

	const sessions = $derived(sortListedSessions(listedSessions(peer)));
	const offline = $derived(!peer.online);

	function label(s: ListedSession): string {
		return s.title || folderName(s.root);
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

<section class="peer" aria-label="On {peer.config.name}">
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
				<button
					class="session"
					class:offline={s.offline}
					class:open={openIds.has(id)}
					class:active={id === activeId}
					aria-label={label(s)}
					title="{label(s)} — {s.root} on {peer.config.name}"
					onclick={() => void open(s)}
				>
					<span class="name">{label(s)}</span>
					<span class="meta"
						>{folderName(s.root)}{s.updatedAt != null
							? ` · ${lastActive(s.updatedAt, now)}`
							: ''}</span
					>
				</button>
			</li>
		{/each}
	</ul>
</section>

<style>
	.peer {
		margin-top: 10px;
	}

	.heading {
		margin: 0;
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

	.session.active {
		background: var(--accent-soft);
		border-left-color: var(--accent);
		color: var(--text-primary);
	}

	.session.offline {
		opacity: 0.5;
	}
</style>
