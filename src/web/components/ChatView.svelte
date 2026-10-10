<script lang="ts">
	/**
	 * One chat. Sending goes through the desktop's own chat, which opens this
	 * conversation there; only one reply can be written at a time, so the
	 * input waits while another chat's is.
	 */
	import type { WebStore } from '../store.svelte.ts';
	import ChatTranscript from './ChatTranscript.svelte';
	import Composer from './Composer.svelte';
	import PromptCard from './PromptCard.svelte';

	let { store }: { store: WebStore } = $props();

	const id = $derived(store.selectedChat!);
	const chat = $derived(store.currentChat);
	const prompts = $derived(store.promptsForChat(id));
	const elsewhere = $derived(store.busyChat && store.busyChat.id !== id ? store.busyChat : null);
</script>

<header>
	<button class="back" onclick={() => (store.selectedChat = null)} aria-label="All chats">‹</button>
	<div class="what">
		<span class="title">{chat?.title || 'New chat'}</span>
		{#if chat?.workingDir}
			<span class="folder" title="The working folder chosen on your computer; change it there."
				>{chat.workingDir}</span
			>
		{/if}
	</div>
	{#if chat && !chat.memoryEnabled}
		<span class="tag" title="This chat isn't remembered (set on your computer).">Incognito</span>
	{/if}
</header>

{#if store.error}
	<p class="error-text banner" role="alert">{store.error}</p>
{/if}

{#if chat}
	<ChatTranscript
		{chat}
		oncontinue={() => store.chatAction(id, 'chat.continue')}
		onretry={() => store.chatAction(id, 'chat.retry')}
	/>
	{#each prompts as p (p.promptId)}
		<PromptCard prompt={p} onanswer={(pid, a) => store.answer(pid, a)} />
	{/each}
	<Composer
		busy={chat.busy}
		steer={false}
		disabled={!!elsewhere}
		why={elsewhere
			? `A reply is being written in "${elsewhere.title}". One chat at a time: wait, or stop it there.`
			: null}
		onsend={(text) => store.sendChat(id, text)}
		onstop={() => store.chatAction(id, 'chat.stop')}
	/>
{:else}
	<p class="hint pad">Opening…</p>
{/if}

<style>
	header {
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 10px 14px;
		border-bottom: 1px solid var(--border);
	}

	.back {
		display: none;
		border: none;
		background: none;
		color: inherit;
		font-size: 1.6rem;
		line-height: 1;
		cursor: pointer;
	}

	.what {
		display: flex;
		flex-direction: column;
		min-width: 0;
		flex: 1;
	}

	.title {
		font-weight: 600;
	}

	.folder {
		font-size: 0.75rem;
		color: var(--text-secondary);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.tag {
		font-size: 0.75rem;
		color: var(--text-secondary);
		border: 1px solid var(--border);
		border-radius: 10px;
		padding: 1px 8px;
	}

	.banner {
		margin: 8px 16px;
	}

	.pad {
		padding: 16px;
	}

	@media (max-width: 899px) {
		.back {
			display: block;
		}
	}
</style>
