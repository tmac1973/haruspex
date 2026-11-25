<script lang="ts">
	/**
	 * One chat. Sending goes through the desktop's own chat, without opening
	 * it there. Each chat runs its own turns, and a message sent while this
	 * one's runs steers it.
	 */
	import type { WebStore } from '../store.svelte.ts';
	import ChatTranscript from './ChatTranscript.svelte';
	import { renderMarkdown } from '#lib/markdown.ts';
	import Composer from './Composer.svelte';
	import PromptCard from './PromptCard.svelte';
	import { messageText } from '#lib/api.ts';
	import { typedText } from '#lib/skills/content.ts';

	let { store }: { store: WebStore } = $props();

	const id = $derived(store.selectedChat!);
	const chat = $derived(store.currentChat);
	const prompts = $derived(store.promptsForChat(id));

	let draft = $state('');
	let pictures = $state<string[]>([]);
	/** The message Edit put back in the box: sending cuts the chat there first. */
	let editing = $state<number | null>(null);
	$effect(() => {
		void id;
		editing = null;
	});

	function edit(index: number): void {
		const msg = chat?.messages[index];
		if (!msg) return;
		editing = index;
		draft = typedText(messageText(msg.content));
		pictures = Array.isArray(msg.content)
			? msg.content.flatMap((p) =>
					p.type === 'image_url' && p.image_url.url.startsWith('data:image/')
						? [p.image_url.url]
						: []
				)
			: [];
	}

	async function send(text: string, pics: string[]): Promise<boolean> {
		if (editing !== null) {
			if (!(await store.rewindChat(id, editing))) return false;
			editing = null;
		}
		return store.sendChat(id, text, pics);
	}
</script>

<header>
	<button class="back" onclick={() => (store.selectedChat = null)} aria-label="All chats">‹</button>
	<div class="what">
		<span class="title">{chat?.title || 'New chat'}</span>
		{#if chat?.workingDir}
			<span class="folder" title="The working folder chosen on your computer; change it there.">
				{chat.workingDir}
			</span>
		{/if}
	</div>
	{#if chat && !chat.memoryEnabled}
		<span class="tag" title="This chat isn't remembered (set on your computer).">Incognito</span>
	{/if}
</header>

{#if store.error}
	<p class="error-text banner" role="alert">{store.error}</p>
{/if}
{#if store.note}
	<div class="banner note" role="status">
		<!-- renderMarkdown sanitises its output. -->
		<!-- eslint-disable-next-line svelte/no-at-html-tags -->
		<div class="note-text">{@html renderMarkdown(store.note)}</div>
		<button class="btn btn-small" onclick={() => (store.note = null)}>OK</button>
	</div>
{/if}

{#if chat}
	<ChatTranscript
		{chat}
		oncontinue={() => store.chatAction(id, 'chat.continue')}
		onretry={() => store.chatAction(id, 'chat.retry')}
		onedit={edit}
		onretryanswer={(i) => void store.retryAnswer(id, i)}
	/>
	{#each prompts as p (p.promptId)}
		<PromptCard prompt={p} onanswer={(pid, a) => store.answer(pid, a)} />
	{/each}
	{#if editing !== null}
		<div class="banner editing" role="status">
			<span>Sending replaces your earlier message and everything after it.</span>
			<button class="btn btn-small" onclick={() => (editing = null)}>Cancel</button>
		</div>
	{/if}
	<Composer
		bind:text={draft}
		bind:pictures
		busy={chat.busy}
		onsend={send}
		onstop={() => store.chatAction(id, 'chat.stop')}
	/>
{:else}
	<p class="hint pad">Opening…</p>
{/if}

<style>
	.editing {
		display: flex;
		gap: 8px;
		align-items: center;
		justify-content: space-between;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	.note {
		display: flex;
		gap: 8px;
		align-items: flex-start;
		justify-content: space-between;
	}

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
