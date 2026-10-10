<script lang="ts">
	/**
	 * The web client's frame: pairing when this browser has no device cookie,
	 * else the session list beside (or, on a phone, instead of) a session.
	 */
	import { onDestroy, onMount } from 'svelte';
	import { pair } from './api.ts';
	import { WebStore } from './store.svelte.ts';
	import PairScreen from './components/PairScreen.svelte';
	import SessionList from './components/SessionList.svelte';
	import SessionView from './components/SessionView.svelte';
	import ChatView from './components/ChatView.svelte';
	import Modal from '#lib/components/Modal.svelte';
	import { VIEW_IMAGE_EVENT } from '#lib/markdown-actions.ts';

	const store = new WebStore();
	let pairError = $state<string | null>(null);
	/** The picture being looked at full size: any message's, inline or attached. */
	let viewing = $state<{ src: string; alt: string } | null>(null);

	$effect(() => {
		const open = (e: Event) => (viewing = (e as CustomEvent<{ src: string; alt: string }>).detail);
		document.addEventListener(VIEW_IMAGE_EVENT, open);
		return () => document.removeEventListener(VIEW_IMAGE_EVENT, open);
	});

	/** The pairing link's code, from the fragment, which never reached a server. */
	function codeFromHash(): string | null {
		const m = /(?:^#|&)pair=([0-9a-f]+)/.exec(location.hash);
		return m ? m[1] : null;
	}

	async function pairWith(code: string): Promise<void> {
		pairError = null;
		try {
			await pair(code);
			store.stop();
			store.start();
		} catch (e) {
			pairError = e instanceof Error ? e.message : String(e);
		}
	}

	onMount(() => {
		const code = codeFromHash();
		// Out of the address bar and the history at once.
		if (code) history.replaceState(null, '', location.pathname);
		if (code) void pairWith(code);
		else store.start();
	});
	onDestroy(() => store.stop());
</script>

<div class="web" class:has-session={store.tab === 'code' ? !!store.selected : !!store.selectedChat}>
	{#if store.connection === 'unauthorised'}
		<PairScreen error={pairError} onpair={pairWith} />
	{:else}
		<aside class="list">
			<SessionList {store} />
		</aside>
		<main class="session">
			{#if store.tab === 'chat' && store.selectedChat}
				<ChatView {store} />
			{:else if store.tab === 'code' && store.selected}
				<SessionView {store} />
			{:else}
				<p class="empty">Pick a session, or start one.</p>
			{/if}
		</main>
	{/if}
</div>

{#if viewing}
	<Modal open title="Image" maxWidth={1100} dismissable onclose={() => (viewing = null)}>
		<img class="full" src={viewing.src} alt={viewing.alt} />
	</Modal>
{/if}

<style>
	:global(html),
	:global(body) {
		margin: 0;
		height: 100%;
		background: var(--bg-primary);
		color: var(--text-primary);
		font-family: system-ui, sans-serif;
	}

	:global(#app) {
		height: 100%;
	}

	.web {
		display: grid;
		/* minmax(0, …): a long code line scrolls in its block, not the page. */
		grid-template-columns: minmax(260px, 320px) minmax(0, 1fr);
		height: 100dvh;
	}

	.list {
		border-right: 1px solid var(--border);
		background: var(--bg-secondary);
		overflow-y: auto;
	}

	.session {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.full {
		display: block;
		max-width: 100%;
		max-height: 75vh;
		margin: 0 auto;
	}

	.empty {
		margin: auto;
		color: var(--text-secondary);
	}

	/* A phone: the list, or the session, not both. */
	@media (max-width: 899px) {
		.web {
			grid-template-columns: minmax(0, 1fr);
		}
		.web.has-session .list,
		.web:not(.has-session) .session {
			display: none;
		}
		.list {
			border-right: none;
		}
	}
</style>
