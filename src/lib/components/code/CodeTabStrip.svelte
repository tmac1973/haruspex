<script lang="ts">
	/**
	 * The open Code sessions as sub-tabs, each with a dot for what it is doing.
	 * Modelled on ShellTabStrip. Closing a session with background processes
	 * running asks first, since closing stops them. Detaching moves an idle
	 * session to a window of its own, its background processes still running.
	 */
	import ConfirmDialog from '#lib/components/ConfirmDialog.svelte';
	import {
		closeSession,
		getActiveSessionId,
		getOpenSessions,
		setActiveSession,
		type CodeSession,
		type CodeSessionStatus
	} from '#lib/stores/code.svelte.ts';
	import { sessionLabel } from '#lib/code/sessionList.ts';
	import { detachSession, moveBlockedReason } from '#lib/code/windows.ts';
	import { showToast } from '#lib/stores/toasts.svelte.ts';
	import { errMessage } from '#lib/utils/error.ts';

	let { onNew }: { onNew: () => void } = $props();

	const sessions = $derived(getOpenSessions());
	const activeId = $derived(getActiveSessionId());

	/** Tooltip for a status dot; idle has no dot. */
	function statusTitle(status: CodeSessionStatus): string {
		if (status === 'running') return 'Working';
		if (status === 'queued') return 'Queued behind another turn';
		if (status === 'waiting-shell') return 'Waiting for a command in the Shell tab';
		return '';
	}

	let confirming = $state<CodeSession | null>(null);

	function detach(event: MouseEvent, session: CodeSession) {
		event.stopPropagation();
		if (moveBlockedReason(session)) return;
		detachSession(session).catch((e: unknown) =>
			showToast(`Couldn't open a window for it: ${errMessage(e)}`, { kind: 'error' })
		);
	}

	function close(event: MouseEvent, session: CodeSession) {
		event.stopPropagation();
		if (session.background.some((p) => p.running)) confirming = session;
		else void closeSession(session.id);
	}
</script>

<div class="strip" role="tablist" aria-label="Code sessions">
	{#each sessions as session (session.id)}
		{@const blocked = moveBlockedReason(session)}
		<div
			class="tab"
			class:active={session.id === activeId}
			role="tab"
			aria-selected={session.id === activeId}
			tabindex="0"
			title="{sessionLabel(session)} — {session.root}"
			onclick={() => setActiveSession(session.id)}
			onkeydown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					setActiveSession(session.id);
				}
			}}
		>
			{#if session.status !== 'idle'}
				<span
					class="dot {session.status}"
					data-status={session.status}
					title={statusTitle(session.status)}
					aria-label={statusTitle(session.status)}
				></span>
			{/if}
			<span class="label">{sessionLabel(session)}</span>
			<button
				class="detach"
				class:blocked={!!blocked}
				aria-disabled={!!blocked}
				title={blocked ?? 'Detach to its own window'}
				aria-label="Detach {sessionLabel(session)}"
				onclick={(e) => detach(e, session)}>⤢</button
			>
			<button
				class="close"
				title="Close session (it stays in the list)"
				aria-label="Close {sessionLabel(session)}"
				onclick={(e) => close(e, session)}>×</button
			>
		</div>
	{/each}
	<button class="add" title="New session" aria-label="New session" onclick={onNew}>+</button>
</div>

<ConfirmDialog
	open={confirming !== null}
	title="Close session?"
	message="Closing it stops its background processes."
	confirmLabel="Close and stop"
	destructive
	onconfirm={() => {
		const s = confirming;
		confirming = null;
		if (s) void closeSession(s.id);
	}}
	oncancel={() => (confirming = null)}
/>

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
		min-height: 30px;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		max-width: 220px;
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

	.tab.active {
		background: var(--bg-primary);
		color: var(--text-primary);
		border-color: var(--border);
	}

	.label {
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		flex-shrink: 0;
	}

	.dot.running {
		background: var(--accent);
	}

	/* Hollow: waiting its turn rather than working. */
	.dot.queued {
		border: 1.5px solid var(--warning);
		box-sizing: border-box;
	}

	.dot.waiting-shell {
		background: var(--warning);
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

	.detach.blocked {
		opacity: 0.3;
		cursor: default;
	}

	.detach.blocked:hover {
		background: none;
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
