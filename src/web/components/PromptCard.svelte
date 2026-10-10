<script lang="ts">
	/**
	 * Something a turn is waiting on a person for. A command approval and the
	 * agent's question are answered here; the rest only say what is waiting,
	 * since they can only be answered on the computer (v1).
	 */
	import type { Prompt, PromptAnswer } from '#lib/engine/types.ts';
	import type { UserQuestionOption } from '#lib/stores/userQuestion.svelte.ts';

	let {
		prompt,
		onanswer
	}: { prompt: Prompt; onanswer: (promptId: string, answer: PromptAnswer) => void } = $props();

	const d = $derived(prompt.detail as Record<string, unknown>);
	const options = $derived((d.options as UserQuestionOption[] | undefined) ?? []);
	let picked = $state<string[]>([]);
	let own = $state('');

	const WAITING: Record<string, string> = {
		mcp: 'An MCP tool wants to run',
		skill: 'The agent wants to save a skill',
		'repo-trust': 'A project asks to be trusted'
	};

	function command(choice: 'allow_once' | 'allow_session' | 'deny'): void {
		onanswer(prompt.promptId, { kind: 'command', choice });
	}

	function sandbox(choice: 'allow_once' | 'allow_chat' | 'deny'): void {
		onanswer(prompt.promptId, { kind: 'sandbox', choice });
	}

	function memory(choice: 'allow_once' | 'allow_session' | 'deny'): void {
		onanswer(prompt.promptId, { kind: 'memory', choice });
	}

	function toggle(label: string): void {
		if (!d.allowMultiple) picked = [label];
		else picked = picked.includes(label) ? picked.filter((l) => l !== label) : [...picked, label];
	}

	function submit(): void {
		const answer = own.trim()
			? ({ kind: 'freeText', text: own.trim() } as const)
			: ({ kind: 'selected', labels: picked } as const);
		onanswer(prompt.promptId, { kind: 'question', answer });
	}
</script>

<div class="card" role="group" aria-label="Waiting for you">
	{#if prompt.kind === 'command'}
		<p class="title">Run this command?</p>
		{#if (d.reasons as string[] | undefined)?.length}
			<p class="why">Flagged: {(d.reasons as string[]).join(', ')}</p>
		{/if}
		<pre class="code-preview"><code>{d.command as string}</code></pre>
		<div class="buttons">
			<button class="btn btn-small" onclick={() => command('allow_once')}>Allow once</button>
			<button class="btn btn-small" onclick={() => command('allow_session')}
				>Allow for this session</button
			>
			<button class="btn btn-small btn-danger" onclick={() => command('deny')}>Deny</button>
		</div>
		{#if (d.queued as number) > 0}
			<p class="why">{d.queued} more waiting after this one.</p>
		{/if}
	{:else if prompt.kind === 'sandbox'}
		<p class="title" title="The Python runs in a sandbox on your computer.">Run this Python?</p>
		<pre class="code-preview"><code>{d.code as string}</code></pre>
		<div class="buttons">
			<button class="btn btn-small" onclick={() => sandbox('allow_once')}>Allow once</button>
			<button
				class="btn btn-small"
				title="Don't ask again in this chat."
				onclick={() => sandbox('allow_chat')}>Allow for this chat</button
			>
			<button class="btn btn-small btn-danger" onclick={() => sandbox('deny')}>Deny</button>
		</div>
	{:else if prompt.kind === 'memory'}
		<p class="title" title="Saved to memory on your computer, for later chats.">Remember this?</p>
		<p class="why">{d.content as string}</p>
		<div class="buttons">
			<button class="btn btn-small" onclick={() => memory('allow_once')}>Allow once</button>
			<button
				class="btn btn-small"
				title="Don't ask again until Haruspex restarts."
				onclick={() => memory('allow_session')}>Allow for this session</button
			>
			<button class="btn btn-small btn-danger" onclick={() => memory('deny')}>Deny</button>
		</div>
	{:else if prompt.kind === 'question'}
		<p class="title">{d.question as string}</p>
		{#if d.body}<p class="why">{d.body as string}</p>{/if}
		<div class="options">
			{#each options as o (o.label)}
				<button
					class="btn btn-small option"
					class:chosen={picked.includes(o.label)}
					title={o.description}
					onclick={() => toggle(o.label)}>{o.label}</button
				>
			{/each}
		</div>
		<input aria-label="Your own answer" placeholder="Or write your own answer" bind:value={own} />
		<button
			class="btn btn-primary btn-small"
			disabled={!own.trim() && picked.length === 0}
			onclick={submit}>Answer</button
		>
	{:else}
		<p class="title">{WAITING[prompt.kind] ?? 'Something is waiting'}</p>
		<p class="why">Answer it on your computer; the turn carries on after that.</p>
	{/if}
</div>

<style>
	.card {
		margin: 8px 16px;
		padding: 12px;
		border: 1px solid var(--accent);
		border-radius: 10px;
		background: var(--bg-raised);
	}

	.title {
		margin: 0 0 6px;
		font-weight: 600;
	}

	.why {
		margin: 4px 0;
		font-size: 0.85rem;
		color: var(--text-secondary);
	}

	pre {
		overflow-x: auto;
		white-space: pre-wrap;
		overflow-wrap: anywhere;
	}

	.buttons,
	.options {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 8px 0;
	}

	.option.chosen {
		border-color: var(--accent);
		color: var(--accent);
	}

	input {
		width: 100%;
		box-sizing: border-box;
		margin: 6px 0;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
	}
</style>
