<script lang="ts">
	/** One session: its header, thread, what it is waiting on, and the input box. */
	import ContextGauge from '#lib/components/ContextGauge.svelte';
	import type { WebStore } from '../store.svelte.ts';
	import Composer from './Composer.svelte';
	import PromptCard from './PromptCard.svelte';
	import Transcript from './Transcript.svelte';
	import FileViewer from './FileViewer.svelte';

	let { store }: { store: WebStore } = $props();

	const id = $derived(store.selected!);
	const session = $derived(store.current);
	const mirror = $derived(store.mirrors[id]);
	const prompts = $derived(store.promptsFor(id));

	function folderName(path: string): string {
		return path.split(/[/\\]/).filter(Boolean).at(-1) ?? path;
	}
</script>

<header>
	<button class="back" onclick={() => (store.selected = null)} aria-label="All sessions">‹</button>
	<div class="what">
		<span class="title">{session?.title || (session ? folderName(session.root) : 'Loading…')}</span>
		{#if session}<span class="folder" title={session.root}>{session.root}</span>{/if}
	</div>
	{#if session?.usage}
		<ContextGauge
			promptTokens={session.usage.promptTokens}
			contextSize={session.usage.contextSize}
			compact
		/>
	{/if}
</header>

{#if store.error}
	<p class="error-text banner" role="alert">{store.error}</p>
{/if}

{#if mirror?.closed}
	<div class="banner">
		Closed on your computer.
		<button class="btn btn-small" onclick={() => store.select(id)}>Open it again</button>
	</div>
{/if}

{#if session}
	{#if session.folderMissing}
		<p class="banner">This session's folder is missing on your computer: {session.root}</p>
	{/if}
	<Transcript
		{session}
		oncontinue={() => store.send(id, 'Please continue from where you stopped.')}
		onopenfile={(path, line) => store.openFile(id, path, line)}
	/>
	{#if session.shellWait}
		<div class="banner">
			Waiting for <code>{session.shellWait.command}</code> to be run in {session.shellWait
				.shellName} on your computer.
			<button class="btn btn-small" onclick={() => store.cancelShellWait(id)}
				>Carry on without it</button
			>
		</div>
	{/if}
	{#each prompts as p (p.promptId)}
		<PromptCard prompt={p} onanswer={(pid, a) => store.answer(pid, a)} />
	{/each}
	<Composer
		busy={session.busy}
		disabled={!!mirror?.closed || session.folderMissing}
		onsend={(text) => store.send(id, text)}
		onstop={() => store.stopTurn(id)}
	/>
{/if}

{#if store.viewer}
	<FileViewer
		file={store.viewer.file}
		error={store.viewer.error}
		line={store.viewer.line}
		onclose={() => (store.viewer = null)}
	/>
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

	.banner {
		margin: 8px 16px;
		padding: 8px 10px;
		border-radius: 8px;
		background: var(--bg-secondary);
		font-size: 0.9rem;
	}

	@media (max-width: 899px) {
		.back {
			display: block;
		}
	}
</style>
