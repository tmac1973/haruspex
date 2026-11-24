<script lang="ts">
	/**
	 * Notebooks on paired computers (Settings → Other computers), a group
	 * per computer under this one's. Read live from that computer while it's
	 * on; nothing is copied here.
	 */
	import { peerViews, type PeerView } from '#lib/peers/store.svelte.ts';
	import { peerBackend } from '#lib/notebooks/backend.svelte.ts';
	import type { NotebookSummary } from '#lib/notebooks/api.ts';
	import {
		getOpenBackend,
		getOpenNotebookId,
		openNotebookOn
	} from '#lib/stores/notebooks.svelte.ts';

	const peers = $derived(peerViews().filter((p) => !p.client.notebooksOff || !p.online));

	let lists = $state<Record<string, NotebookSummary[] | null>>({});
	let closed = $state<Record<string, boolean>>({});

	async function load(peer: PeerView) {
		try {
			lists[peer.id] = await peerBackend(peer.id, peer.config.name, peer.client).list();
		} catch (e) {
			console.warn('notebooks on another computer', e);
			lists[peer.id] = null;
		}
	}

	$effect(() => {
		for (const p of peers) {
			if (p.online && !p.client.notebooksOff && lists[p.id] === undefined) void load(p);
		}
	});

	// A notebook made or changed there shows here.
	$effect(() => {
		const offs = peers.map((p) => p.client.onNotebookChanged(() => void load(p)));
		return () => offs.forEach((off) => off());
	});

	function open(peer: PeerView, id: string) {
		void openNotebookOn(
			peerBackend(peer.id, peer.config.name, peer.client),
			id,
			undefined,
			undefined,
			peer.client
		);
	}
</script>

{#each peers as peer (peer.id)}
	<div class="peer" class:offline={!peer.online}>
		<button
			class="head"
			onclick={() => (closed[peer.id] = !closed[peer.id])}
			aria-expanded={!closed[peer.id]}
		>
			<span>{closed[peer.id] ? '▸' : '▾'} {peer.config.name}</span>
			{#if !peer.online}<span class="state">Offline</span>{/if}
		</button>
		{#if !closed[peer.id] && peer.online}
			<ul>
				{#each lists[peer.id] ?? [] as nb (nb.id)}
					<li>
						<button
							class="item"
							class:active={getOpenBackend().peerId === peer.id && getOpenNotebookId() === nb.id}
							onclick={() => open(peer, nb.id)}
						>
							<span class="name">{nb.pinned ? '📌 ' : ''}{nb.title}</span>
							<span class="meta">{nb.card_count} cards</span>
						</button>
					</li>
				{:else}
					<li class="empty">{lists[peer.id] === undefined ? 'Loading…' : 'No notebooks.'}</li>
				{/each}
			</ul>
		{/if}
	</div>
{/each}

<style>
	.peer {
		margin-top: 6px;
		padding: 0 6px;
	}

	.peer.offline {
		opacity: 0.6;
	}

	.head {
		display: flex;
		justify-content: space-between;
		width: 100%;
		border: none;
		background: none;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.8rem;
		font-weight: 600;
		padding: 6px 8px 2px;
		text-align: left;
	}

	.state {
		font-weight: normal;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0;
	}

	.item {
		display: flex;
		flex-direction: column;
		width: 100%;
		text-align: left;
		border: none;
		border-radius: 6px;
		background: none;
		color: var(--text-primary);
		cursor: pointer;
		padding: 6px 8px;
	}

	.item:hover {
		background: var(--bg-primary);
	}

	.item.active {
		background: var(--accent-soft);
	}

	.name {
		font-size: 0.9rem;
	}

	.meta,
	.empty {
		color: var(--text-muted);
		font-size: 0.75rem;
	}

	.empty {
		padding: 4px 8px;
	}
</style>
