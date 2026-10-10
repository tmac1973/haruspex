<script lang="ts">
	/**
	 * A session's thread, laid out as the desktop's Code transcript does:
	 * the steps of each finished turn above its answer, then the turn in
	 * flight (its steps, its text so far, and anything queued to steer it).
	 * Steps are the desktop's own `CodeSteps`, without file links.
	 */
	import type { SearchStep } from '#lib/agent/loop.ts';
	import CodeSteps from '#lib/components/code/CodeSteps.svelte';
	import StopIndicator from '#lib/components/StopIndicator.svelte';
	import ThinkingIndicator from '#lib/components/ThinkingIndicator.svelte';
	import type { SessionState } from '#lib/engine/types.ts';
	import Message from './Message.svelte';

	let {
		session,
		oncontinue,
		onopenfile
	}: {
		session: SessionState;
		oncontinue: () => void;
		/** Open a file (relative to the folder) in the viewer, at a line if given. */
		onopenfile: (path: string, line: number | null) => void;
	} = $props();

	const openFile = (rel: string) => onopenfile(rel, null);

	/**
	 * File links in rendered markdown are buttons carrying `data-path` (and
	 * `data-line`); markdown can't hold handlers, so they are caught here.
	 */
	function onThreadClick(event: MouseEvent): void {
		const btn = (event.target as HTMLElement | null)?.closest<HTMLElement>(
			'button[data-action="code-path"]'
		);
		const path = btn?.dataset.path;
		if (!path) return;
		event.preventDefault();
		const line = Number(btn.dataset.line);
		onopenfile(path, Number.isFinite(line) && line > 0 ? line : null);
	}

	/** Only what a person reads: tool-call rounds show as their steps instead. */
	const shown = $derived(
		session.messages
			.map((msg, i) => ({ msg, i }))
			.filter(({ msg }) => msg.role !== 'tool' && msg.role !== 'system' && !msg.tool_calls)
	);
	const steps = (i: number) => (session.messageSteps[i] ?? []) as SearchStep[];
	const stopAt = (i: number) => session.messageStops[i] as string | undefined;

	let thread = $state<HTMLDivElement | null>(null);
	let follow = true;
	function onScroll(): void {
		if (thread) follow = thread.scrollHeight - thread.scrollTop - thread.clientHeight < 48;
	}
	$effect(() => {
		void session.messages.length;
		void session.streamingContent;
		void session.searchSteps.length;
		if (thread && follow) queueMicrotask(() => thread && (thread.scrollTop = thread.scrollHeight));
	});
</script>

<!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
<div class="thread" bind:this={thread} onscroll={onScroll} onclick={onThreadClick}>
	{#each shown as { msg, i } (i)}
		{#if msg.role === 'assistant' && steps(i).length}
			<CodeSteps steps={steps(i)} root={session.root} {openFile} />
		{/if}
		<Message message={msg} root={session.root} />
		{#if stopAt(i)}
			<StopIndicator reason={stopAt(i) as never} disabled={session.busy} onContinue={oncontinue} />
		{/if}
	{/each}
	{#if session.searchSteps.length}
		<CodeSteps steps={session.searchSteps as SearchStep[]} root={session.root} {openFile} />
	{/if}
	{#if session.streamingContent}
		<Message
			message={{ role: 'assistant', content: session.streamingContent }}
			streaming
			root={session.root}
		/>
	{/if}
	{#if session.roundText}
		<Message message={{ role: 'assistant', content: session.roundText }} streaming />
	{:else if !session.streamingContent && session.status === 'running'}
		<ThinkingIndicator />
	{/if}
	{#each session.steering as text, k (k)}
		<div class="steer" title="Given to the agent at its next step.">
			<span class="tag">Queued</span>{text}
		</div>
	{/each}
	{#if session.status === 'queued'}
		<p class="hint">Waiting for another turn to finish…</p>
	{/if}
	{#if session.lastError}
		<p class="error-text">{session.lastError}</p>
	{/if}
</div>

<style>
	.thread {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		min-height: 0;
	}

	.thread :global(.code-path) {
		appearance: none;
		background: none;
		border: 0;
		padding: 0;
		font: inherit;
		color: var(--accent);
		cursor: pointer;
		text-decoration: underline dotted;
		text-underline-offset: 2px;
	}

	.thread :global(.code-path:hover) {
		text-decoration-style: solid;
	}

	.steer {
		margin: 6px 0;
		padding: 8px 10px;
		border: 1px dashed var(--border-strong);
		border-radius: 8px;
		font-size: 0.9rem;
	}

	.tag {
		margin-right: 8px;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
</style>
