<script lang="ts">
	/**
	 * Something a turn is waiting on a person for, answered here as the
	 * desktop's modal would answer it. A kind this page doesn't know yet only
	 * says what is waiting.
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
	/** The skill's file as it will be saved; starts as the agent wrote it. */
	let skillText = $state('');
	let reason = $state('');
	let loadedFor: string | null = null;
	$effect(() => {
		if (prompt.kind === 'skill' && loadedFor !== prompt.promptId) {
			loadedFor = prompt.promptId;
			skillText = (d.text as string) ?? '';
			reason = '';
		}
	});

	const args = $derived(
		d.args && Object.keys(d.args as object).length > 0 ? JSON.stringify(d.args, null, 2) : null
	);
	/** What an MCP tool says about itself, as the desktop's modal words it. */
	const hints = $derived.by(() => {
		const a = d.annotations as Record<string, boolean | undefined> | null | undefined;
		if (!a) return 'This server does not say whether the tool changes anything.';
		const out: string[] = [];
		if (a.destructiveHint === true) out.push('may delete or overwrite things');
		if (a.idempotentHint === false) out.push('repeating it has additional effect');
		if (a.openWorldHint === true) out.push('reaches services outside this machine');
		return out.length ? `This tool ${out.join('; ')}.` : null;
	});
	/** What a repo would bring in: "2 skills and an AGENTS.md". */
	const brings = $derived.by(() => {
		const parts: string[] = [];
		const n = (d.skills as number) ?? 0;
		if (n > 0) parts.push(`${n} skill${n === 1 ? '' : 's'}`);
		if (d.agentsMd) parts.push('an AGENTS.md');
		return parts.join(' and ');
	});
	const change = $derived(
		d.change as
			| { kind: 'origin'; was: string | null; now: string | null }
			| { kind: 'skills'; added: string[] }
			| null
	);

	function mcp(choice: 'allow_once' | 'allow_always' | 'deny'): void {
		onanswer(prompt.promptId, { kind: 'mcp', choice });
	}

	function skill(save: boolean): void {
		onanswer(
			prompt.promptId,
			save
				? { kind: 'skill', action: 'save', text: skillText }
				: { kind: 'skill', action: 'reject', reason: reason.trim() }
		);
	}

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
	{:else if prompt.kind === 'mcp'}
		<p class="title">Allow {d.server as string} to run {d.tool as string}?</p>
		{#if d.description}<p class="why">{d.description as string}</p>{/if}
		{#if hints}<p class="why">{hints}</p>{/if}
		{#if args}<pre class="code-preview"><code>{args}</code></pre>{/if}
		<div class="buttons">
			<button class="btn btn-small" onclick={() => mcp('allow_once')}>Allow once</button>
			<button
				class="btn btn-small"
				title="Don't ask again for this tool on this server."
				onclick={() => mcp('allow_always')}>Always allow</button
			>
			<button class="btn btn-small btn-danger" onclick={() => mcp('deny')}>Deny</button>
		</div>
	{:else if prompt.kind === 'skill'}
		{@const agentsMd = d.kind === 'agentsMd'}
		<p class="title" title={d.dir as string}>
			{#if agentsMd}
				{d.update ? "Change this repo's AGENTS.md?" : 'Add an AGENTS.md to this repo?'}
			{:else}
				{d.update ? 'Change' : 'Save'} the "{d.name as string}" skill?
			{/if}
		</p>
		<textarea
			aria-label={agentsMd ? 'AGENTS.md' : 'SKILL.md'}
			title="Edit it first if you like; this is what gets saved."
			rows="12"
			bind:value={skillText}></textarea>
		<input
			aria-label="Reason, if you reject it"
			placeholder="Reason, if you reject it"
			bind:value={reason}
		/>
		<div class="buttons">
			<button class="btn btn-small" onclick={() => skill(true)}
				>{d.update ? 'Save changes' : 'Save'}</button
			>
			<button
				class="btn btn-small btn-danger"
				title="Nothing is written; the model is told why."
				onclick={() => skill(false)}>Reject</button
			>
		</div>
	{:else if prompt.kind === 'repo-trust'}
		<p class="title" title="You can change this in Settings → Skills.">
			{#if change?.kind === 'origin'}
				A different repo is in this folder
			{:else if change?.kind === 'skills'}
				This repo has new skills
			{:else}
				Use this repo's instructions?
			{/if}
		</p>
		<p class="why">
			{#if change?.kind === 'skills'}
				Added: {change.added.join(', ')}.
			{:else}
				It has {brings} for the assistant to follow.
			{/if}
		</p>
		<p class="why path">{d.root as string}</p>
		<div class="buttons">
			<button
				class="btn btn-small"
				onclick={() => onanswer(prompt.promptId, { kind: 'repo-trust', trust: true })}
				>Use them</button
			>
			<button
				class="btn btn-small btn-danger"
				title="The assistant works here without them."
				onclick={() => onanswer(prompt.promptId, { kind: 'repo-trust', trust: false })}
				>Ignore them</button
			>
		</div>
	{:else if prompt.kind === 'screen-capture'}
		<p
			class="title"
			title="Haruspex hides on your computer while it captures, and the assistant sees the picture."
		>
			{d.target === 'window' ? 'Take a screenshot of your window?' : 'Take a screenshot?'}
		</p>
		<div class="buttons">
			<button
				class="btn btn-small"
				onclick={() => onanswer(prompt.promptId, { kind: 'screen-capture', choice: 'allow' })}
				>Take it</button
			>
			<button
				class="btn btn-small btn-danger"
				title="Nothing is captured; the model is told you declined."
				onclick={() => onanswer(prompt.promptId, { kind: 'screen-capture', choice: 'deny' })}
				>Don't</button
			>
		</div>
	{:else}
		<p class="title">Something is waiting</p>
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

	.path {
		overflow-wrap: anywhere;
	}

	textarea {
		width: 100%;
		box-sizing: border-box;
		padding: 8px;
		border: 1px solid var(--border);
		border-radius: 6px;
		background: var(--bg-input);
		color: var(--text-primary);
		font-family: var(--font-mono, monospace);
		font-size: 0.85rem;
		resize: vertical;
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
