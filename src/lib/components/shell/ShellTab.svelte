<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import Terminal, { type TerminalHandle } from './Terminal.svelte';
	import ChatSidebar from './ChatSidebar.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';
	import {
		bindShellSession,
		focusShellComposer,
		getShellSidebarOpen,
		isShellComposerFocused,
		setShellSidebarOpen,
		submitChatMessage,
		toggleShellSidebar,
		unbindShellSession
	} from '$lib/stores/shell.svelte';

	let handle = $state<TerminalHandle | null>(null);
	let hasSelection = $state(false);
	let menu = $state<{ x: number; y: number } | null>(null);
	let copyFeedback = $state<string | null>(null);

	async function copySelectionToClipboard(): Promise<boolean> {
		const text = handle?.getSelection() ?? '';
		if (!text) return false;
		try {
			await navigator.clipboard.writeText(text);
			copyFeedback = 'Copied';
			setTimeout(() => (copyFeedback = null), 1200);
			return true;
		} catch (e) {
			console.error('clipboard.writeText failed', e);
			return false;
		}
	}

	async function pasteFromClipboard(): Promise<boolean> {
		if (!handle) return false;
		try {
			const text = await navigator.clipboard.readText();
			if (!text) return false;
			await invoke('shell_write', { sessionId: handle.sessionId, data: text });
			handle.focus();
			return true;
		} catch (e) {
			console.error('clipboard.readText failed', e);
			return false;
		}
	}

	function onTerminalReady(h: TerminalHandle) {
		handle = h;
		bindShellSession({
			sessionId: h.sessionId,
			context: h.context,
			getSelection: h.getSelection
		});
	}

	type Shortcut = { match: (e: KeyboardEvent) => boolean; run: () => void };

	// F1 toggle sidebar, Ctrl+` focus swap, Ctrl+Shift+C copy,
	// Ctrl+Shift+V paste. Plain Ctrl+C stays as SIGINT for bash;
	// Ctrl+backtick is unused in readline.
	const shortcuts: Shortcut[] = [
		{
			match: (e) => e.key === 'F1' && !e.ctrlKey && !e.shiftKey && !e.altKey,
			run: toggleShellSidebar
		},
		{
			match: (e) => e.ctrlKey && !e.shiftKey && !e.altKey && e.code === 'Backquote',
			run: swapFocus
		},
		{
			match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyC',
			run: () => void copySelectionToClipboard()
		},
		{
			match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyV',
			run: () => void pasteFromClipboard()
		}
	];

	function onKeyDown(event: KeyboardEvent) {
		if (getActiveTab() !== 'shell') return;
		for (const s of shortcuts) {
			if (s.match(event)) {
				event.preventDefault();
				s.run();
				return;
			}
		}
	}

	function swapFocus() {
		if (isShellComposerFocused()) {
			handle?.focus();
			return;
		}
		if (!getShellSidebarOpen()) {
			setShellSidebarOpen(true);
		}
		// The sidebar may have just opened; wait one microtask for the
		// composer to render before focusing it.
		queueMicrotask(() => focusShellComposer());
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

	interface ShellContextSnapshot {
		marker_count: number;
	}

	async function getMarkerCount(): Promise<number> {
		if (!handle) return 0;
		try {
			const res = await invoke<ShellContextSnapshot>('shell_get_context', {
				sessionId: handle.sessionId
			});
			return res.marker_count;
		} catch {
			return 0;
		}
	}

	/**
	 * Pastes the command, presses Enter, waits for the OSC 133 D marker
	 * (command complete), and submits a follow-up. The auto-attach picks
	 * up the just-run command + output, so the model gets context
	 * without the user having to do anything else.
	 *
	 * Times out after 60 s — long-running commands (htop, watch, vim)
	 * never finish and we don't want to hang forever. If we timeout
	 * we drop the auto-submit silently; the user can ask manually.
	 */
	async function onRunRequest(event: Event) {
		const data = (event as CustomEvent<string>).detail;
		if (typeof data !== 'string' || !handle) return;
		const cleaned = data.replace(/[\r\n]+$/, '').trim();
		if (!cleaned) return;
		const before = await getMarkerCount();
		try {
			await invoke('shell_write', { sessionId: handle.sessionId, data: cleaned + '\n' });
			handle.focus();
		} catch (e) {
			console.error('shell_write (run) failed', e);
			return;
		}
		// Poll for the D marker. Each complete cycle adds 4 markers
		// (A, B, C, D), but conservatively we wait for at least 2 new
		// markers since C+D arrives during the command and the new A+B
		// land once the prompt redraws.
		const startedAt = Date.now();
		const timeoutMs = 60_000;
		const pollMs = 400;
		while (Date.now() - startedAt < timeoutMs) {
			await new Promise((r) => setTimeout(r, pollMs));
			const now = await getMarkerCount();
			if (now >= before + 2) break;
		}
		if (Date.now() - startedAt >= timeoutMs) return;
		await submitChatMessage(`Please analyze the output of \`${cleaned}\` that I just ran.`);
	}

	onMount(() => {
		window.addEventListener('click', dismissMenu);
		document.addEventListener('hsp-shell-paste', onPasteRequest);
		document.addEventListener('hsp-shell-run', onRunRequest);
		return () => {
			document.body.classList.remove('shell-tab-active');
			window.removeEventListener('click', dismissMenu);
			document.removeEventListener('hsp-shell-paste', onPasteRequest);
			document.removeEventListener('hsp-shell-run', onRunRequest);
			unbindShellSession();
		};
	});

	// Track tab activation rather than mount lifecycle. ShellTab stays
	// mounted across tab switches (so the PTY survives), so we toggle
	// body class / focus whenever it becomes the active tab — not just
	// on first mount.
	$effect(() => {
		const active = getActiveTab() === 'shell';
		if (active) {
			document.body.classList.add('shell-tab-active');
			queueMicrotask(() => handle?.focus());
		} else {
			document.body.classList.remove('shell-tab-active');
		}
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="shell-tab" oncontextmenu={onContextMenu} role="presentation">
	<div class="terminal-region">
		<div class="terminal-pane">
			<Terminal onReady={onTerminalReady} onSelectionChange={(has) => (hasSelection = has)} />
		</div>
	</div>
	<ChatSidebar />
	{#if menu}
		<div class="context-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu" tabindex="-1">
			<button onclick={copySelectionToClipboard} disabled={!hasSelection}>
				Copy<span class="kbd">Ctrl+Shift+C</span>
			</button>
			<button onclick={pasteFromClipboard}>
				Paste<span class="kbd">Ctrl+Shift+V</span>
			</button>
			<hr />
			<button onclick={() => handle?.restart()} disabled={!handle}> Restart shell </button>
		</div>
	{/if}
	{#if copyFeedback}
		<div class="toast">{copyFeedback}</div>
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
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}

	.context-menu button:hover:not(:disabled) {
		background: var(--bg-secondary);
	}

	.context-menu button:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.context-menu .kbd {
		font-size: 0.7rem;
		color: var(--text-secondary);
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', monospace;
	}

	.context-menu hr {
		margin: 4px 0;
		border: 0;
		border-top: 1px solid var(--border);
	}

	.toast {
		position: absolute;
		bottom: 18px;
		left: 50%;
		transform: translateX(-50%);
		padding: 6px 14px;
		background: var(--bg-primary);
		color: var(--text-primary);
		border: 1px solid var(--border);
		border-radius: 14px;
		font-size: 0.78rem;
		box-shadow: 0 2px 8px rgba(0, 0, 0, 0.25);
		z-index: 20;
		pointer-events: none;
	}
</style>
