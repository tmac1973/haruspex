<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import Terminal, { type TerminalHandle } from './Terminal.svelte';
	import ChatSidebar from './ChatSidebar.svelte';
	import Modal from '$lib/components/Modal.svelte';
	import ModalButton from '$lib/components/ModalButton.svelte';
	import { classifyShellRisk, type RiskMatch } from '$lib/shell/risky-commands';
	import { stripCommandComments, toBracketedPaste } from '$lib/shell/commandBlock';
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
	let riskyConfirm = $state<{ command: string; reasons: RiskMatch[] } | null>(null);
	// Default to true so the placeholder doesn't flash on a supported
	// platform (Linux/macOS) during the round-trip; the backend flips it to
	// false on unsupported platforms (Windows, until Phase 17).
	let platformSupported = $state<boolean>(true);

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
		// Drop comment-only and blank lines so they don't each become a
		// shell-history entry. No trailing Enter — the paste doesn't
		// auto-execute; the user presses Enter themselves (the security
		// model). Bracketed paste keeps the shell's line editor from
		// mangling the text (auto-closed quotes, reprints, autosuggestions).
		const cleaned = stripCommandComments(data);
		if (!cleaned) return;
		invoke('shell_write', { sessionId: handle.sessionId, data: toBracketedPaste(cleaned) })
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
	 * Run flow: paste the command, press Enter, wait for the next OSC
	 * 133 D marker, then auto-submit a follow-up so the freshly-run
	 * command + output get attached for the model to analyze.
	 *
	 * Risky patterns (sudo, rm -rf, dd of=, mkfs, curl|sh, writes under
	 * /etc, …) route through a confirm modal first so single-click
	 * execution can't trigger something destructive. Once confirmed
	 * (or for non-risky commands), executeRunCommand does the actual
	 * paste + wait + submit.
	 *
	 * Times out after 60 s — long-running commands (htop, watch, vim)
	 * never finish; we drop the auto-submit silently and the user can
	 * ask manually.
	 */
	function onRunRequest(event: Event) {
		const data = (event as CustomEvent<string>).detail;
		if (typeof data !== 'string' || !handle) return;
		// Strip comment-only and blank lines so only real commands run
		// (and only they land in shell history).
		const cleaned = stripCommandComments(data).trim();
		if (!cleaned) return;
		const risk = classifyShellRisk(cleaned);
		if (risk.matched) {
			riskyConfirm = { command: cleaned, reasons: risk.reasons };
			return;
		}
		void executeRunCommand(cleaned);
	}

	function confirmRiskyRun() {
		const pending = riskyConfirm;
		riskyConfirm = null;
		if (pending) void executeRunCommand(pending.command);
	}

	function cancelRiskyRun() {
		riskyConfirm = null;
	}

	async function executeRunCommand(cleaned: string) {
		if (!handle) return;
		const before = await getMarkerCount();
		try {
			// Bracketed paste + a trailing Enter: the shell inserts the
			// command(s) literally (no quote/highlight mangling) then runs.
			await invoke('shell_write', {
				sessionId: handle.sessionId,
				data: toBracketedPaste(cleaned, true)
			});
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
		invoke<boolean>('shell_platform_supported')
			.then((ok) => (platformSupported = ok))
			.catch(() => (platformSupported = true));
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

<div class="shell-tab" role="presentation">
	{#if !platformSupported}
		<div class="platform-placeholder">
			<div class="platform-card">
				<h2>Shell tab — not yet on Windows</h2>
				<p>
					Haruspex's interactive terminal + AI sidebar ships on Linux and macOS. The PTY layer is
					cross-platform, but the OSC 133 capture scripts and the assistant's auto-attach context
					rely on bash/zsh — not <code>cmd.exe</code> or PowerShell.
				</p>
				<p>
					Windows support is the next stop: it needs new capture scripting for PowerShell or WSL
					bridging. The chat and jobs tabs work normally on every platform — switch to those for
					now.
				</p>
			</div>
		</div>
	{:else}
		<div class="terminal-region">
			<div class="terminal-pane" oncontextmenu={onContextMenu} role="presentation">
				<Terminal onReady={onTerminalReady} onSelectionChange={(has) => (hasSelection = has)} />
			</div>
		</div>
		<ChatSidebar />
	{/if}
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
	<Modal open={riskyConfirm !== null} labelledBy="risky-confirm-title">
		{#if riskyConfirm}
			<h2 id="risky-confirm-title">⚠ Run risky command?</h2>
			<p>The assistant suggested a command that matches one or more risky patterns:</p>
			<ul class="risk-list">
				{#each riskyConfirm.reasons as r (r.label)}
					<li><strong>{r.label}</strong> — {r.description}</li>
				{/each}
			</ul>
			<pre class="risky-cmd">{riskyConfirm.command}</pre>
			<p class="hint">
				Clicking <strong>Run anyway</strong> will type this command at your shell prompt, press
				Enter, and send the output back to the assistant for analysis. <strong>Cancel</strong> leaves
				nothing typed.
			</p>
			<div class="actions-row">
				<ModalButton variant="subtle" onclick={cancelRiskyRun}>
					{#snippet title()}Cancel{/snippet}
					{#snippet subtitle()}Don't run anything{/snippet}
				</ModalButton>
				<ModalButton variant="danger" onclick={confirmRiskyRun}>
					{#snippet title()}Run anyway{/snippet}
					{#snippet subtitle()}I've read the command and accept the risk{/snippet}
				</ModalButton>
			</div>
		{/if}
	</Modal>
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

	.platform-placeholder {
		flex: 1 1 auto;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 2rem;
		overflow: auto;
	}

	.platform-card {
		max-width: 560px;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 8px;
		padding: 1.5rem 1.75rem;
		color: var(--text-primary);
	}

	.platform-card h2 {
		margin: 0 0 0.75rem 0;
		font-size: 1.1rem;
	}

	.platform-card p {
		margin: 0.5rem 0;
		font-size: 0.9rem;
		line-height: 1.5;
		color: var(--text-secondary);
	}

	.platform-card code {
		font-family: var(--font-mono, ui-monospace, monospace);
		font-size: 0.85em;
		padding: 0 0.25em;
		background: var(--bg-secondary, rgba(255, 255, 255, 0.05));
		border-radius: 3px;
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

	.risk-list {
		margin: 0 0 12px 0;
		padding-left: 20px;
		font-size: 0.85rem;
		color: var(--text-primary);
	}

	.risk-list li {
		margin-bottom: 4px;
	}

	.risky-cmd {
		background: var(--code-bg);
		color: #f87171;
		padding: 10px 12px;
		border-radius: 6px;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace;
		font-size: 0.85rem;
		overflow-x: auto;
		margin: 0 0 12px 0;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.hint {
		font-size: 0.8rem;
		color: var(--text-secondary);
		margin-bottom: 14px !important;
	}

	.actions-row {
		display: flex;
		flex-direction: column;
		gap: 8px;
	}
</style>
