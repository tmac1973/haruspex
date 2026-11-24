<script lang="ts">
	/** One notebook on the web: its cards, and its chat in a drawer. */
	import { tick } from 'svelte';
	import { renderMarkdown } from '#lib/markdown.ts';
	import ThinkingIndicator from '#lib/components/ThinkingIndicator.svelte';
	import WebCard from './WebCard.svelte';
	import type { WebNotebooks } from '../../notebooks.svelte.ts';

	let { nb }: { nb: WebNotebooks } = $props();

	const open = $derived(nb.open!);
	let chatOpen = $state(false);
	let text = $state('');

	$effect(() => {
		const f = nb.focus;
		if (!f) return;
		void tick().then(() =>
			document.getElementById(`web-card-${f.cardId}`)?.scrollIntoView({ block: 'start' })
		);
	});

	function send() {
		const t = text.trim();
		if (!t) return;
		text = '';
		void nb.sendChat(t);
	}
</script>

<div class="page">
	<header>
		<button class="back" onclick={() => nb.close()} aria-label="Back to notebooks">‹</button>
		<h2>{open.notebook.title}</h2>
		<button class="ask" onclick={() => (chatOpen = !chatOpen)}>{chatOpen ? 'Cards' : 'Ask'}</button>
	</header>
	{#if chatOpen}
		<div class="chat">
			{#each nb.chat?.messages ?? [] as m, i (i)}
				<div class="msg {m.role}">
					{#if m.role === 'user'}<p>{m.content}</p>{:else}<div class="markdown">
							{@html renderMarkdown(m.content)}
						</div>{/if}
				</div>
			{:else}
				<p class="hint">Ask the agent to organize, research or add to this notebook.</p>
			{/each}
			{#if nb.chat?.busy}
				<div class="msg assistant">
					{#if nb.chat.streaming}<div class="markdown">
							{@html renderMarkdown(nb.chat.streaming)}
						</div>{/if}
					<ThinkingIndicator bare caption={nb.chat.step ?? 'Working…'} />
				</div>
			{/if}
			{#if nb.chat?.error}<p class="error">{nb.chat.error}</p>{/if}
		</div>
		<form
			class="composer"
			onsubmit={(e) => {
				e.preventDefault();
				send();
			}}
		>
			<textarea bind:value={text} rows="2" aria-label="Message" placeholder="Organize these notes…"
			></textarea>
			{#if nb.chat?.busy}
				<button type="button" onclick={() => void nb.stopChat()}>Stop</button>
			{:else}
				<button type="submit" class="primary">Send</button>
			{/if}
		</form>
	{:else}
		<div class="cards">
			{#each open.cards as card (card.id)}
				<WebCard {card} {nb} />
			{:else}
				<p class="hint">No cards yet.</p>
			{/each}
			<div class="add">
				<button onclick={() => void nb.addCard('text')}>+ Text</button>
				<button onclick={() => void nb.addCard('table')}>+ Table</button>
				<button onclick={() => void nb.addCard('checklist')}>+ Checklist</button>
			</div>
		</div>
	{/if}
</div>

<style>
	.page {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
	}

	header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
	}

	h2 {
		flex: 1;
		margin: 0;
		font-size: 1.1rem;
	}

	.back,
	.ask,
	.add button,
	.composer button {
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-raised);
		color: var(--text-primary);
		padding: 4px 10px;
		cursor: pointer;
	}

	.cards,
	.chat {
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: 12px;
	}

	.add {
		display: flex;
		gap: 6px;
		flex-wrap: wrap;
	}

	.msg.user p {
		background: var(--user-bubble);
		padding: 6px 10px;
		border-radius: 8px;
		white-space: pre-wrap;
	}

	.composer {
		display: flex;
		gap: 6px;
		padding: 8px 12px;
		border-top: 1px solid var(--border);
	}

	.composer textarea {
		flex: 1;
		padding: 6px 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font: inherit;
	}

	.composer .primary {
		border: none;
		background: var(--accent);
		color: var(--accent-contrast);
	}

	.hint {
		color: var(--text-muted);
		font-size: 0.85rem;
	}

	.error {
		color: var(--error-text);
	}
</style>
