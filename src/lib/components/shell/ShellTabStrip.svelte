<script lang="ts">
	import {
		getShellSessions,
		getActiveShellId,
		getActiveShellSession,
		setActiveShell,
		createShellSession,
		closeShellSession,
		type ShellSession
	} from '$lib/stores/shell.svelte';
	import { openDetachedShell } from '$lib/shell/windows';
	import ShellPicker from './ShellPicker.svelte';

	const sessions = $derived(getShellSessions());
	const activeId = $derived(getActiveShellId());

	function close(event: MouseEvent, id: string) {
		// Don't let the click also select the tab being closed.
		event.stopPropagation();
		closeShellSession(id);
	}

	function detach(event: MouseEvent, session: ShellSession) {
		event.stopPropagation();
		void openDetachedShell(session);
	}
</script>

<div class="strip" role="tablist" aria-label="Shell tabs">
	{#each sessions as session (session.id)}
		<div
			class="tab"
			class:active={session.id === activeId}
			role="tab"
			aria-selected={session.id === activeId}
			tabindex="0"
			onclick={() => setActiveShell(session.id)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					setActiveShell(session.id);
				}
			}}
		>
			<span class="label">{session.name}</span>
			{#if session.isSubmitting}
				<span class="busy" title="A turn is running" aria-label="running">●</span>
			{/if}
			<button
				class="detach"
				title="Detach to its own window"
				aria-label="Detach {session.name}"
				onclick={(e) => detach(e, session)}>⤢</button
			>
			{#if sessions.length > 1}
				<button
					class="close"
					title="Close shell"
					aria-label="Close {session.name}"
					onclick={(e) => close(e, session.id)}>×</button
				>
			{/if}
		</div>
	{/each}
	<button class="add" title="New shell" aria-label="New shell" onclick={() => createShellSession()}
		>+</button
	>
	<ShellPicker onPick={() => void getActiveShellSession()?.restartActive()} />
</div>

<style>
	.strip {
		display: flex;
		align-items: stretch;
		gap: 2px;
		padding: 4px 6px 0 6px;
		background: var(--bg-secondary);
		border-bottom: 1px solid var(--border);
		overflow-x: auto;
		flex: 0 0 auto;
		min-height: 0;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 5px 10px;
		font-size: 0.78rem;
		color: var(--text-secondary);
		background: transparent;
		border: 1px solid transparent;
		border-bottom: none;
		border-radius: 6px 6px 0 0;
		cursor: pointer;
		white-space: nowrap;
		user-select: none;
	}

	.tab:hover {
		background: var(--bg-primary);
		color: var(--text-primary);
	}

	/* The active tab connects visually to the terminal below, which is an
	   always-dark surface — so it keeps the terminal background in both
	   themes rather than the theme surface. */
	.tab.active {
		background: var(--code-bg);
		color: var(--text-primary);
		border-color: var(--border);
	}

	.busy {
		color: var(--accent);
		font-size: 0.6rem;
		line-height: 1;
	}

	.close,
	.detach {
		appearance: none;
		background: none;
		border: 0;
		color: inherit;
		opacity: 0.6;
		cursor: pointer;
		font-size: 0.95rem;
		line-height: 1;
		padding: 0 2px;
		border-radius: 3px;
	}

	.detach {
		font-size: 0.8rem;
	}

	.close:hover,
	.detach:hover {
		opacity: 1;
		background: var(--bg-secondary);
	}

	.add {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-secondary);
		cursor: pointer;
		font-size: 1.05rem;
		line-height: 1;
		padding: 0 8px;
		border-radius: 6px;
	}

	.add:hover {
		color: var(--text-primary);
		background: var(--bg-primary);
	}
</style>
