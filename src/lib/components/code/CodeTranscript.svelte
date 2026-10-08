<script lang="ts">
	/**
	 * A Code session's conversation: messages, the tool cards each answer
	 * came from, the running turn, and steering waiting to be delivered.
	 *
	 * The whole thread is saved, so a long session is rendered from its last
	 * `TURNS_PER_PAGE` turns, with "Show earlier" for the rest.
	 */
	import { onDestroy, untrack } from 'svelte';
	import ChatMessage from '#lib/components/ChatMessage.svelte';
	import StopIndicator from '#lib/components/StopIndicator.svelte';
	import ThinkingIndicator from '#lib/components/ThinkingIndicator.svelte';
	import CodeSteps from './CodeSteps.svelte';
	import { messageText } from '#lib/api.ts';
	import { TURNS_PER_PAGE, turnsBefore, windowStart } from '#lib/code/sessionList.ts';
	import type { CodeSession } from '#lib/stores/code.svelte.ts';

	let { session, notes = [] }: { session: CodeSession; notes?: string[] } = $props();

	let turnsShown = $state(TURNS_PER_PAGE);
	const messages = $derived(session.messages);
	const start = $derived(windowStart(messages, turnsShown));
	const earlier = $derived(turnsBefore(messages, start));
	const shown = $derived(messages.slice(start).map((msg, k) => ({ msg, i: start + k })));

	// Throttled streaming, as the Shell sidebar does: re-rendering markdown
	// on every token is O(length) per chunk and stalls long answers.
	const STREAM_RENDER_MS = 150;

	/** `read()`, re-read at most every STREAM_RENDER_MS; empty at once. */
	function throttled(read: () => string): { readonly value: string } {
		let shown = $state('');
		let timer: ReturnType<typeof setTimeout> | null = null;
		$effect(() => {
			const current = read();
			untrack(() => {
				if (!current) {
					shown = '';
					if (timer !== null) clearTimeout(timer);
					timer = null;
				} else if (!shown) {
					shown = current;
				} else if (timer === null) {
					timer = setTimeout(() => {
						shown = read();
						timer = null;
					}, STREAM_RENDER_MS);
				}
			});
		});
		onDestroy(() => {
			if (timer !== null) clearTimeout(timer);
		});
		return {
			get value() {
				return shown;
			}
		};
	}

	const answerStream = throttled(() => session.streamingContent);
	// The tool round in flight: its reasoning and text while it is written.
	const roundStream = throttled(() => session.roundText ?? '');
	const streamText = $derived(answerStream.value);
	const roundText = $derived(roundStream.value);
	const pending = $derived(session.pendingToolCalls ?? []);

	const ticket = $derived(session.ticket);

	// Keep the newest output in view.
	let threadEl = $state<HTMLDivElement | null>(null);
	$effect(() => {
		void messages.length;
		void streamText;
		void roundText;
		void pending.length;
		void session.searchSteps.length;
		void session.steering.length;
		void notes.length;
		if (!threadEl) return;
		queueMicrotask(() => {
			if (threadEl) threadEl.scrollTop = threadEl.scrollHeight;
		});
	});

	function removePending(index: number) {
		session.steering = session.steering.filter((_, k) => k !== index);
	}
</script>

<div class="thread" bind:this={threadEl} data-testid="code-transcript">
	{#if messages.length === 0 && !session.busy}
		<div class="placeholder">
			Ask for a change in <code>{session.root}</code>. Hold <kbd>F2</kbd> to speak.
		</div>
	{/if}
	{#if earlier > 0}
		<button
			class="earlier"
			onclick={() => (turnsShown += TURNS_PER_PAGE)}
			title="Older turns are saved; they are left out here to keep the tab quick."
			>Show earlier ({earlier} more turn{earlier === 1 ? '' : 's'})</button
		>
	{/if}
	{#each shown as { msg, i } (i)}
		{#if msg.role !== 'tool' && !msg.tool_calls}
			{#if msg.role === 'system'}
				<div class="note">{messageText(msg.content)}</div>
			{:else if msg.role === 'user'}
				<ChatMessage message={msg} />
			{:else}
				{#if session.messageSteps[i]?.length}
					<CodeSteps steps={session.messageSteps[i]} />
				{/if}
				<ChatMessage
					message={msg}
					tokensPerSecond={session.messageStats[i]?.tokensPerSecond}
					elapsedMs={session.messageStats[i]?.elapsedMs}
				/>
				{#if session.messageStops[i]}
					<StopIndicator
						reason={session.messageStops[i]}
						disabled={session.busy}
						onContinue={session.continueTurn}
					/>
				{/if}
			{/if}
		{/if}
	{/each}
	{#if session.searchSteps.length > 0}
		<CodeSteps steps={session.searchSteps} />
	{/if}
	{#each session.steeringDelivered as text, k (k)}
		<div class="steer delivered" title="The agent has read this.">
			<span class="tag">Delivered</span>
			<span class="text">{text}</span>
		</div>
	{/each}
	{#if streamText}
		<ChatMessage message={{ role: 'assistant', content: streamText }} isStreaming />
	{/if}
	{#if roundText}
		<!-- Only alongside the answer after steering: the answer clears it. -->
		<ChatMessage message={{ role: 'assistant', content: roundText }} isStreaming />
	{:else if !streamText && session.status === 'running' && pending.length === 0}
		<ThinkingIndicator />
	{/if}
	{#if pending.length > 0}
		<CodeSteps steps={[]} {pending} />
	{/if}
	{#each session.steering as text, k (k)}
		<div class="steer pending" title="Given to the agent at its next step.">
			<span class="tag">Queued</span>
			<span class="text">{text}</span>
			<button
				class="drop"
				onclick={() => removePending(k)}
				title="Don't send this"
				aria-label="Remove queued message">×</button
			>
		</div>
	{/each}
	{#if session.status === 'queued'}
		<div class="hint">Waiting for another turn to finish…</div>
	{/if}
	{#if session.status === 'waiting-shell'}
		<div class="hint">Waiting for the command in the Shell tab…</div>
	{/if}
	{#if ticket && ticket.state === 'waiting' && session.status !== 'queued'}
		<div class="hint">Waiting for the model…</div>
	{/if}
	{#if session.contextNotice}
		<div class="hint">ⓘ {session.contextNotice}</div>
	{/if}
	{#each notes as note, k (k)}
		<div class="note">{note}</div>
	{/each}
	{#if session.lastError}
		<div class="error">{session.lastError}</div>
	{/if}
	{#if session.saveError}
		<div class="error" title={session.saveError}>
			This session couldn't be saved. It will try again after the next message.
		</div>
	{/if}
</div>

<style>
	.thread {
		flex: 1 1 auto;
		min-height: 0;
		overflow-y: auto;
		padding: 10px 16px 16px;
	}

	.placeholder {
		color: var(--text-secondary);
		font-size: 0.88rem;
		padding: 24px 8px;
		text-align: center;
		line-height: 1.5;
	}

	.placeholder code {
		font-size: 0.82rem;
		word-break: break-all;
	}

	.earlier {
		display: block;
		margin: 0 auto 10px;
		appearance: none;
		background: none;
		border: 1px solid var(--border);
		border-radius: 999px;
		padding: 3px 12px;
		font-size: 0.75rem;
		color: var(--text-secondary);
		cursor: pointer;
	}

	.earlier:hover {
		color: var(--text-primary);
		border-color: var(--accent);
	}

	.note {
		margin: 8px 0;
		padding: 6px 10px;
		border-left: 2px solid var(--border);
		font-size: 0.78rem;
		line-height: 1.45;
		color: var(--text-secondary);
		font-style: italic;
		white-space: pre-wrap;
	}

	.steer {
		display: flex;
		align-items: flex-start;
		gap: 8px;
		margin: 6px 0 6px auto;
		max-width: 80%;
		width: fit-content;
		padding: 6px 10px;
		border-radius: 10px;
		background: var(--user-bubble);
		font-size: 0.85rem;
		white-space: pre-wrap;
	}

	.steer.pending {
		border: 1px dashed var(--border-strong);
		opacity: 0.85;
	}

	.steer.delivered {
		border: 1px solid var(--accent-soft);
	}

	.tag {
		flex-shrink: 0;
		font-size: 0.65rem;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--text-secondary);
		padding-top: 2px;
	}

	.delivered .tag {
		color: var(--accent);
	}

	.drop {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
		padding: 0 2px;
	}

	.drop:hover {
		color: var(--text-primary);
	}

	.hint {
		font-size: 0.78rem;
		color: var(--text-secondary);
		font-style: italic;
		padding: 6px 4px;
	}

	.error {
		font-size: 0.8rem;
		color: var(--error-text);
		padding: 8px;
		border: 1px solid var(--error-text);
		border-radius: 6px;
		margin-top: 8px;
	}
</style>
