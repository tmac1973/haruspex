<script lang="ts">
	// Workspace tab body. Hosts the IframePool's host div (which in
	// turn contains the per-chat iframes), plus controls (Reset, Stop
	// tasks) and the stdout/stderr console.
	//
	// Lifecycle:
	//   - On mount: append pool.host into our mount div.
	//   - On chat change: pool.setActive(chatId).
	//   - On tab activation: clear fresh-content badge for the active
	//     chat (markFreshContentSeen).

	import { onMount, onDestroy } from 'svelte';
	import { getActiveConversationId } from '$lib/stores/chat.svelte';
	import { getActiveTab, setActiveTab } from '$lib/stores/activeTab.svelte';
	import {
		getWorkspacePool,
		markFreshContentSeen,
		setStageWriteHook,
		shouldAutoSwitch
	} from '$lib/workspace/workspace.svelte';
	import WorkspaceConsole from './WorkspaceConsole.svelte';

	let mountEl: HTMLDivElement | null = $state(null);
	let attached = $state(false);
	let resetting = $state(false);

	const activeChatId = $derived(getActiveConversationId());
	const activeTab = $derived(getActiveTab());

	onMount(() => {
		// Auto-switch to Workspace the first time the active chat
		// writes to the stage in a given turn.
		setStageWriteHook((chatId) => {
			if (chatId !== getActiveConversationId()) return;
			if (getActiveTab() !== 'chat') return;
			if (!shouldAutoSwitch(chatId)) return;
			setActiveTab('workspace');
		});
	});

	// Attach pool.host to the stage div as soon as the stage is in the
	// DOM. Done via $effect (not onMount) because the stage is rendered
	// unconditionally now but bind:this updates can occur after the
	// component's initial mount — using onMount would race against the
	// bind. Iframes only navigate to their src when their ancestor
	// chain reaches the document, so this is load-bearing for every
	// run_python call to complete.
	$effect(() => {
		if (attached || !mountEl) return;
		const pool = getWorkspacePool();
		// eslint-disable-next-line svelte/no-dom-manipulating
		mountEl.appendChild(pool.host);
		attached = true;
	});

	onDestroy(() => {
		setStageWriteHook(null);
		// Don't terminate the pool; it lives as long as the app does.
	});

	// When the active chat changes, set the pool's active iframe so
	// visibility swaps and the right console shows.
	$effect(() => {
		const chatId = activeChatId;
		if (!chatId) return;
		const pool = getWorkspacePool();
		pool.setActive(chatId);
	});

	// When the user opens the Workspace tab, clear the fresh-content
	// badge for the active chat.
	$effect(() => {
		if (activeTab !== 'workspace') return;
		const chatId = activeChatId;
		if (chatId) markFreshContentSeen(chatId);
	});

	async function doReset(): Promise<void> {
		const chatId = activeChatId;
		if (!chatId) return;
		resetting = true;
		try {
			await getWorkspacePool().reset(chatId);
		} finally {
			resetting = false;
		}
	}

	async function doStopTasks(): Promise<void> {
		const chatId = activeChatId;
		if (!chatId) return;
		const pool = getWorkspacePool();
		if (!pool.hasIframeFor(chatId)) return;
		await pool.runPython(chatId, 'import haruspex; haruspex.stop_tasks()');
	}
</script>

<div class="workspace-tab">
	{#if activeChatId}
		<div class="controls">
			<button onclick={doReset} disabled={resetting}>
				{resetting ? 'Resetting…' : 'Reset session'}
			</button>
			<button onclick={doStopTasks}>Stop background tasks</button>
			<span class="hint"
				>Per-chat Python state. Switching chats keeps each session alive (up to 3).</span
			>
		</div>
	{/if}
	<!--
		Stage is rendered unconditionally — pool.host must reach the DOM
		for the iframe inside to navigate to its src. The empty / no-chat
		overlays sit on top via absolute positioning.
	-->
	<div class="stage" bind:this={mountEl}>
		{#if !activeChatId}
			<div class="empty overlay">
				<p>Open or create a chat first.</p>
			</div>
		{/if}
	</div>
	{#if activeChatId}
		<WorkspaceConsole chatId={activeChatId} />
	{/if}
</div>

<style>
	.workspace-tab {
		display: flex;
		flex-direction: column;
		height: 100%;
		overflow: hidden;
	}
	.controls {
		display: flex;
		gap: 0.5rem;
		align-items: center;
		padding: 0.5rem 0.75rem;
		border-bottom: 1px solid var(--border);
		flex-wrap: wrap;
	}
	.controls button {
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		padding: 0.3rem 0.7rem;
		font-size: 0.85rem;
		cursor: pointer;
		border-radius: 4px;
	}
	.controls button:hover {
		background: var(--bg-tertiary);
	}
	.controls button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}
	.controls .hint {
		font-size: 0.75rem;
		color: var(--text-secondary);
	}
	.stage {
		position: relative;
		flex: 1;
		min-height: 0;
		background: var(--bg-primary);
	}
	.empty {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100%;
		color: var(--text-secondary);
		font-size: 0.9rem;
		padding: 1rem;
		text-align: center;
	}
	.empty.overlay {
		position: absolute;
		inset: 0;
		pointer-events: none;
	}
</style>
