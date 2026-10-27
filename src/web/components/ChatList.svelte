<script lang="ts">
	/** The desktop's chats, newest first, each marked with what it is doing. */
	import type { WebStore } from '../store.svelte.ts';

	let { store }: { store: WebStore } = $props();

	function when(at: number): string {
		const d = new Date(at);
		const today = new Date().toDateString() === d.toDateString();
		return today
			? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
			: d.toLocaleDateString();
	}
</script>

<button
	class="btn btn-small new-btn"
	title="Start a new chat on your computer."
	onclick={() => store.newChat()}>New chat</button
>

<ul>
	{#each store.chats as c (c.id)}
		<li>
			<button
				class="item"
				class:active={c.id === store.selectedChat}
				onclick={() => store.selectChat(c.id)}
			>
				<span class="name">{c.title || 'New chat'}</span>
				<span class="meta">
					<span>{when(c.updatedAt)}</span>
					{#if c.waiting}
						<span class="sep">·</span>
						<span class="status" title="Waiting for the model, or for another reply to finish."
							>Waiting</span
						>
					{:else if c.busy}
						<span class="sep">·</span>
						<span class="status" title="A reply is being written.">Writing</span>
					{:else if c.unread}
						<span class="sep">·</span>
						<span class="status" title="It finished a reply you haven't opened yet.">New</span>
					{:else if c.open}
						<span class="sep">·</span>
						<span title="The chat open on your computer.">Open</span>
					{/if}
				</span>
			</button>
		</li>
	{:else}
		<li class="none">No chats yet.</li>
	{/each}
</ul>

<style>
	.new-btn {
		margin: 0 14px 8px;
	}

	ul {
		list-style: none;
		margin: 0;
		padding: 0 6px 12px;
	}

	.item {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		gap: 2px;
		width: 100%;
		padding: 10px;
		border: none;
		border-radius: 8px;
		background: none;
		color: inherit;
		text-align: left;
		cursor: pointer;
		font: inherit;
	}

	.item:hover,
	.item.active {
		background: var(--bg-raised);
	}

	.name {
		font-weight: 500;
		overflow-wrap: anywhere;
	}

	.meta {
		display: flex;
		gap: 5px;
		font-size: 0.78rem;
		color: var(--text-secondary);
	}

	.status {
		color: var(--accent);
	}

	.none {
		padding: 10px;
		color: var(--text-secondary);
	}
</style>
