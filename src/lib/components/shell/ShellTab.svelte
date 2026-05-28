<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import Terminal, { type TerminalHandle } from './Terminal.svelte';
	import ChatSidebar from './ChatSidebar.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';
	import { getSettings } from '$lib/stores/settings';
	import {
		bindShellSession,
		isShellSubmitting,
		setShellSidebarOpen,
		submitFromTerminal,
		unbindShellSession
	} from '$lib/stores/shell.svelte';

	let handle = $state<TerminalHandle | null>(null);
	let hasSelection = $state(false);
	let menu = $state<{ x: number; y: number } | null>(null);

	const submitting = $derived(isShellSubmitting());

	function onTerminalReady(h: TerminalHandle) {
		handle = h;
		bindShellSession({
			sessionId: h.sessionId,
			context: h.context,
			getSelection: h.getSelection
		});
	}

	function onKeyDown(event: KeyboardEvent) {
		if (getActiveTab() !== 'shell') return;
		// Ctrl+Shift+L → submit to LLM. Deliberately Shift to avoid clashing
		// with readline's Ctrl+L clear-screen.
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
			event.preventDefault();
			submitFromTerminal();
		}
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		menu = { x: event.clientX, y: event.clientY };
	}

	function dismissMenu() {
		menu = null;
	}

	function onPasteRequest(event: Event) {
		const data = (event as CustomEvent<string>).detail;
		if (typeof data !== 'string' || !handle) return;
		// Trim trailing newlines so the paste doesn't auto-execute. The
		// user must press Enter themselves — that's the security model.
		const cleaned = data.replace(/[\r\n]+$/, '');
		if (!cleaned) return;
		invoke('shell_write', { sessionId: handle.sessionId, data: cleaned })
			.then(() => handle?.focus())
			.catch((e) => console.error('shell_write (paste) failed', e));
	}

	onMount(() => {
		document.body.classList.add('shell-tab-active');
		if (getSettings().shellSidebarDefaultOpen) {
			setShellSidebarOpen(true);
		}
		window.addEventListener('click', dismissMenu);
		document.addEventListener('hsp-shell-paste', onPasteRequest);
		return () => {
			document.body.classList.remove('shell-tab-active');
			window.removeEventListener('click', dismissMenu);
			document.removeEventListener('hsp-shell-paste', onPasteRequest);
			unbindShellSession();
		};
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="shell-tab" oncontextmenu={onContextMenu} role="presentation">
	<div class="terminal-region">
		<div class="toolbar">
			<button
				class="primary"
				onclick={submitFromTerminal}
				disabled={!handle || submitting}
				title="Submit to LLM (Ctrl+Shift+L)"
			>
				{#if submitting}
					Working…
				{:else if hasSelection}
					Submit selection
				{:else}
					Submit last command
				{/if}
			</button>
		</div>
		<div class="terminal-pane">
			<Terminal onReady={onTerminalReady} onSelectionChange={(has) => (hasSelection = has)} />
		</div>
	</div>
	<ChatSidebar />
	{#if menu}
		<div class="context-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu" tabindex="-1">
			<button onclick={submitFromTerminal}>Send to LLM</button>
		</div>
	{/if}
</div>

<style>
	.shell-tab {
		display: flex;
		flex-direction: row;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		position: relative;
	}

	.terminal-region {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.toolbar {
		display: flex;
		gap: 6px;
		padding: 6px 8px;
		border-bottom: 1px solid var(--border);
		background: var(--bg-primary);
		flex-shrink: 0;
	}

	.toolbar button {
		appearance: none;
		background: var(--bg-secondary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		padding: 4px 12px;
		font-size: 0.8rem;
		border-radius: 4px;
		cursor: pointer;
	}

	.toolbar button:hover:not(:disabled) {
		background: var(--bg-tertiary, var(--bg-secondary));
	}

	.toolbar button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.toolbar button.primary {
		background: var(--accent);
		color: white;
		border-color: var(--accent);
	}

	.terminal-pane {
		position: relative;
		flex: 1 1 auto;
		min-width: 0;
		min-height: 0;
	}

	.context-menu {
		position: fixed;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 4px;
		box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
		z-index: 10;
		min-width: 160px;
		padding: 4px 0;
	}

	.context-menu button {
		appearance: none;
		background: none;
		border: 0;
		color: var(--text-primary);
		padding: 6px 14px;
		font-size: 0.8rem;
		width: 100%;
		text-align: left;
		cursor: pointer;
	}

	.context-menu button:hover {
		background: var(--bg-secondary);
	}
</style>
