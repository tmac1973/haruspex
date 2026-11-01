<script lang="ts">
	/**
	 * The open shells as sub-tabs. Many tabs shrink, then scroll; the active
	 * one is kept in view, and New shell and the shell picker stay outside the
	 * scroll.
	 */
	import {
		getShellSessions,
		getActiveShellId,
		getActiveShellSession,
		setActiveShell,
		createShellSession,
		closeShellSession,
		type ShellSession
	} from '#lib/stores/shell.svelte.ts';
	import { openDetachedShell } from '#lib/shell/windows.ts';
	import ShellPicker from '#lib/components/shell/ShellPicker.svelte';

	const sessions = $derived(getShellSessions());
	const activeId = $derived(getActiveShellId());

	let scroller = $state<HTMLDivElement>();

	// Keep the active tab in view when it changes or a shell opens.
	$effect(() => {
		const id = activeId;
		void sessions.length;
		const tab = scroller?.querySelector<HTMLElement>(`[data-shell-id="${CSS.escape(id ?? '')}"]`);
		tab?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
	});

	// A plain mouse wheel scrolls the strip sideways. Not passive, so it can
	// keep the page from taking the wheel too.
	$effect(() => {
		const el = scroller;
		if (!el) return;
		const onWheel = (event: WheelEvent) => {
			if (event.deltaX !== 0 || event.deltaY === 0) return;
			if (el.scrollWidth <= el.clientWidth) return;
			event.preventDefault();
			el.scrollLeft += event.deltaY;
		};
		el.addEventListener('wheel', onWheel, { passive: false });
		return () => el.removeEventListener('wheel', onWheel);
	});

	/** ← → Home End move focus along the tabs, as in a tablist; Enter opens one. */
	function moveFocus(event: KeyboardEvent) {
		const tabs = [...(scroller?.querySelectorAll<HTMLElement>('[role="tab"]') ?? [])];
		const at = tabs.indexOf(event.currentTarget as HTMLElement);
		const to =
			event.key === 'ArrowRight'
				? Math.min(at + 1, tabs.length - 1)
				: event.key === 'ArrowLeft'
					? Math.max(at - 1, 0)
					: event.key === 'Home'
						? 0
						: tabs.length - 1;
		event.preventDefault();
		tabs[to]?.focus();
	}

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

<div class="strip">
	<div class="tabs thin-scroll" role="tablist" aria-label="Shell tabs" bind:this={scroller}>
		{#each sessions as session (session.id)}
			<div
				class="tab"
				data-shell-id={session.id}
				class:active={session.id === activeId}
				role="tab"
				aria-selected={session.id === activeId}
				tabindex="0"
				onclick={() => setActiveShell(session.id)}
				onkeydown={(e) => {
					if (e.key === 'Enter' || e.key === ' ') {
						e.preventDefault();
						setActiveShell(session.id);
					} else if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
						moveFocus(e);
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
	</div>
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
		flex: 0 0 auto;
		min-width: 0;
		min-height: 0;
	}

	.tabs {
		display: flex;
		align-items: stretch;
		gap: 2px;
		flex: 0 1 auto;
		min-width: 0;
		overflow-x: auto;
		overflow-y: hidden;
	}

	/* Thinner than thin-scroll, since it sits under the tabs. */
	.tabs::-webkit-scrollbar {
		height: 6px;
	}

	.tab {
		display: flex;
		align-items: center;
		gap: 6px;
		flex: 0 1 auto;
		min-width: 110px;
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

	/* The active tab connects visually to the terminal below, which is an
	   always-dark surface — so it keeps the terminal background in both
	   themes rather than the theme surface. */
	.tab.active {
		background: var(--code-bg);
		color: var(--text-primary);
		border-color: var(--border);
	}

	.label {
		flex: 1 1 auto;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.busy {
		flex-shrink: 0;
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
		flex-shrink: 0;
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
		flex-shrink: 0;
	}

	.add:hover {
		color: var(--text-primary);
		background: var(--bg-primary);
	}
</style>
