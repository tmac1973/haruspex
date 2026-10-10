<script lang="ts">
	/**
	 * A chat's thread, as the desktop's chat tab lays it out: each answer's
	 * steps above it, then the reply being written. Steps are the desktop's
	 * own `SearchStep`, without the sandbox's run controls (the sandbox runs on
	 * the computer).
	 */
	import type { SearchStep as Step } from '#lib/agent/loop.ts';
	import SearchStep from '#lib/components/SearchStep.svelte';
	import StopIndicator from '#lib/components/StopIndicator.svelte';
	import ThinkingIndicator from '#lib/components/ThinkingIndicator.svelte';
	import type { ChatState } from '#lib/engine/types.ts';
	import Message from './Message.svelte';

	let {
		chat,
		oncontinue,
		onretry
	}: { chat: ChatState; oncontinue: () => void; onretry: () => void } = $props();

	/** What a person reads: tool rounds show as their steps instead. */
	const shown = $derived(
		chat.messages
			.map((msg, i) => ({ msg, i }))
			.filter(({ msg }) => msg.role !== 'tool' && msg.role !== 'system' && !msg.tool_calls)
	);
	const steps = (i: number) => (chat.messageSteps[i] ?? []) as Step[];
	const stopAt = (i: number) => chat.messageStops[i] as string | undefined;

	let thread = $state<HTMLDivElement | null>(null);
	let follow = true;
	function onScroll(): void {
		if (thread) follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
	}
	$effect(() => {
		void chat.messages.length;
		void chat.streamingContent;
		void chat.searchSteps.length;
		if (thread && follow) queueMicrotask(() => thread && (thread.scrollTop = thread.scrollHeight));
	});
</script>

<div class="thread" bind:this={thread} onscroll={onScroll}>
	{#each shown as { msg, i } (i)}
		{#if msg.role === 'assistant' && steps(i).length}
			<SearchStep steps={steps(i)} runControls={false} />
		{/if}
		<Message message={msg} />
		{#if stopAt(i)}
			<StopIndicator reason={stopAt(i) as never} disabled={chat.busy} onContinue={oncontinue} />
		{/if}
	{/each}
	{#if chat.searchSteps.length}
		<SearchStep steps={chat.searchSteps} runControls={false} />
	{/if}
	{#if chat.streamingContent}
		<Message message={{ role: 'assistant', content: chat.streamingContent }} streaming />
	{:else if chat.busy && !chat.waitingForSlot}
		<ThinkingIndicator />
	{/if}
	{#if chat.waitingForSlot}
		<p class="hint">Waiting for another turn to finish…</p>
	{/if}
	{#if chat.compacting}
		<p class="hint">Making room in the conversation…</p>
	{/if}
	{#if chat.error}
		<div class="error-text failed">
			{chat.error}
			{#if chat.lastTurnFailed}
				<button
					class="btn btn-small"
					title="Send the last message again."
					disabled={chat.busy}
					onclick={onretry}>Retry</button
				>
			{/if}
		</div>
	{/if}
</div>

<style>
	.thread {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		min-height: 0;
	}

	.failed {
		display: flex;
		gap: 10px;
		align-items: center;
		margin-top: 8px;
	}
</style>
