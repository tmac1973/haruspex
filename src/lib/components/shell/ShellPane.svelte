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
	import { getActiveShellId, type ShellSession } from '$lib/stores/shell.svelte';
	import { getSettings } from '$lib/stores/settings';

	const {
		session,
		standalone = false,
		attachSessionId
	}: { session: ShellSession; standalone?: boolean; attachSessionId?: number } = $props();

	// Only the active pane responds to window/document-level events. All panes
	// stay mounted (so background PTYs survive), so every pane registers these
	// listeners — this guard ensures just one acts. A standalone pane (its own
	// detached window) is always the active one.
	const isActive = $derived(
		standalone || (getActiveTab() === 'shell' && getActiveShellId() === session.id)
	);

	let handle = $state<TerminalHandle | null>(null);
	let hasSelection = $state(false);
	let menu = $state<{ x: number; y: number } | null>(null);
	let copyFeedback = $state<string | null>(null);
	let riskyConfirm = $state<{
		command: string;
		reasons: RiskMatch[];
		action: 'paste' | 'run';
	} | null>(null);

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
		session.bindSession({
			sessionId: h.sessionId,
			context: h.context,
			getSelection: h.getSelection,
			serialize: h.serialize
		});
	}

	type Shortcut = { match: (e: KeyboardEvent) => boolean; run: () => void };

	// Ctrl+Shift+A toggle sidebar (F1 is the app-wide shortcuts help),
	// Ctrl+` focus swap, Ctrl+Shift+C copy, Ctrl+Shift+V paste. Plain
	// Ctrl+C stays as SIGINT for bash; Ctrl+backtick is unused in readline.
	const shortcuts: Shortcut[] = [
		{
			match: (e) => e.ctrlKey && e.shiftKey && !e.altKey && e.code === 'KeyA',
			run: () => session.toggleSidebar()
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
		if (!isActive) return;
		for (const s of shortcuts) {
			if (s.match(event)) {
				event.preventDefault();
				s.run();
				return;
			}
		}
	}

	function swapFocus() {
		if (session.isComposerFocused()) {
			handle?.focus();
			return;
		}
		if (!session.sidebarOpen) {
			session.setSidebarOpen(true);
		}
		// The sidebar may have just opened; wait one microtask for the composer
		// to render before focusing it.
		queueMicrotask(() => session.focusComposer());
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		menu = { x: event.clientX, y: event.clientY };
	}

	function dismissMenu() {
		menu = null;
	}

	function onPasteRequest(event: Event) {
		if (!isActive) return;
		const data = (event as CustomEvent<string>).detail;
		if (typeof data !== 'string' || !handle) return;
		// Drop comment-only and blank lines so they don't each become a
		// shell-history entry.
		const cleaned = stripCommandComments(data);
		if (!cleaned) return;
		// Same risk gate as Run: even though paste doesn't auto-execute, the
		// command is about to sit at the prompt one Enter away, so warn first.
		const risk = classifyShellRisk(cleaned);
		if (risk.matched) {
			riskyConfirm = { command: cleaned, reasons: risk.reasons, action: 'paste' };
			return;
		}
		executePaste(cleaned);
	}

	// No trailing Enter — the paste doesn't auto-execute; the user presses
	// Enter themselves (the security model). Bracketed paste keeps the shell's
	// line editor from mangling the text (auto-closed quotes, reprints,
	// autosuggestions).
	function executePaste(cleaned: string) {
		if (!handle) return;
		invoke('shell_write', { sessionId: handle.sessionId, data: toBracketedPaste(cleaned) })
			.then(() => handle?.focus())
			.catch((e) => console.error('shell_write (paste) failed', e));
	}

	interface ShellContextSnapshot {
		completed_total: number;
	}

	// Monotonic lifetime count of completed commands. We poll this (rather than
	// the marker count) to detect the Run command finishing — marker_count caps
	// at the ring size (256) and plateaus once a shell has run enough commands,
	// which broke the auto-submit on long-lived / detached sessions.
	async function getCompletedTotal(): Promise<number> {
		if (!handle) return 0;
		try {
			const res = await invoke<ShellContextSnapshot>('shell_get_context', {
				sessionId: handle.sessionId
			});
			return res.completed_total;
		} catch {
			return 0;
		}
	}

	/**
	 * Run flow: paste the command, press Enter, wait for the next OSC 133 D
	 * marker, then auto-submit a follow-up so the freshly-run command + output
	 * get attached for the model to analyze.
	 *
	 * Risky patterns (sudo, rm -rf, dd of=, mkfs, curl|sh, writes under /etc, …)
	 * route through a confirm modal first so single-click execution can't
	 * trigger something destructive. Once confirmed (or for non-risky
	 * commands), executeRunCommand does the actual paste + wait + submit.
	 *
	 * Times out after 60 s — long-running commands (htop, watch, vim) never
	 * finish; we drop the auto-submit silently and the user can ask manually.
	 */
	function onRunRequest(event: Event) {
		if (!isActive) return;
		const data = (event as CustomEvent<string>).detail;
		if (typeof data !== 'string' || !handle) return;
		// Strip comment-only and blank lines so only real commands run (and
		// only they land in shell history).
		const cleaned = stripCommandComments(data).trim();
		if (!cleaned) return;
		const risk = classifyShellRisk(cleaned);
		if (risk.matched) {
			riskyConfirm = { command: cleaned, reasons: risk.reasons, action: 'run' };
			return;
		}
		void executeRunCommand(cleaned);
	}

	function confirmRisky() {
		const pending = riskyConfirm;
		riskyConfirm = null;
		if (!pending) return;
		if (pending.action === 'paste') executePaste(pending.command);
		else void executeRunCommand(pending.command);
	}

	function cancelRisky() {
		riskyConfirm = null;
	}

	async function executeRunCommand(cleaned: string) {
		if (!handle) return;
		const before = await getCompletedTotal();
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
		// When auto-submit is disabled, Run just executes the command in the
		// terminal — we don't poll for completion or send the output back to
		// the assistant. The user stays in control of what the model sees.
		if (!getSettings().shellRunAutoSubmit) return;
		// Wait for one more completed command (a new D / OutputEnd marker) —
		// i.e. the command we just launched returning to a prompt. Long-running
		// / interactive commands never finish; we time out and drop the
		// auto-submit silently.
		const startedAt = Date.now();
		const timeoutMs = 60_000;
		const pollMs = 400;
		while (Date.now() - startedAt < timeoutMs) {
			await new Promise((r) => setTimeout(r, pollMs));
			const now = await getCompletedTotal();
			if (now > before) break;
		}
		if (Date.now() - startedAt >= timeoutMs) return;
		await session.submitChatMessage(`Please analyze the output of \`${cleaned}\` that I just ran.`);
	}

	onMount(() => {
		window.addEventListener('click', dismissMenu);
		document.addEventListener('hsp-shell-paste', onPasteRequest);
		document.addEventListener('hsp-shell-run', onRunRequest);
		return () => {
			window.removeEventListener('click', dismissMenu);
			document.removeEventListener('hsp-shell-paste', onPasteRequest);
			document.removeEventListener('hsp-shell-run', onRunRequest);
			session.unbindSession();
		};
	});

	// Focus this pane's terminal when it becomes the active shell tab.
	$effect(() => {
		if (isActive) queueMicrotask(() => handle?.focus());
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="shell-pane" role="presentation">
	<div class="terminal-region">
		<div class="terminal-pane" oncontextmenu={onContextMenu} role="presentation">
			<Terminal
				{attachSessionId}
				onReady={onTerminalReady}
				onSelectionChange={(has) => (hasSelection = has)}
			/>
		</div>
	</div>
	<ChatSidebar {session} />
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
			<h2 id="risky-confirm-title">
				⚠ {riskyConfirm.action === 'run' ? 'Run' : 'Paste'} risky command?
			</h2>
			<p>The assistant suggested a command that matches one or more risky patterns:</p>
			<ul class="risk-list">
				{#each riskyConfirm.reasons as r (r.label)}
					<li><strong>{r.label}</strong> — {r.description}</li>
				{/each}
			</ul>
			<pre class="risky-cmd">{riskyConfirm.command}</pre>
			<p class="hint">
				{#if riskyConfirm.action === 'run'}
					Clicking <strong>Run anyway</strong> will type this command at your shell prompt, press Enter,
					and send the output back to the assistant for analysis.
				{:else}
					Clicking <strong>Paste anyway</strong> will type this command at your shell prompt — it won't
					run until you press Enter yourself.
				{/if}
				<strong>Cancel</strong> leaves nothing typed.
			</p>
			<div class="actions-row">
				<ModalButton variant="subtle" onclick={cancelRisky}>
					{#snippet title()}Cancel{/snippet}
					{#snippet subtitle()}Don't type anything{/snippet}
				</ModalButton>
				<ModalButton variant="danger" onclick={confirmRisky}>
					{#snippet title()}{riskyConfirm?.action === 'run'
							? 'Run anyway'
							: 'Paste anyway'}{/snippet}
					{#snippet subtitle()}I've read the command and accept the risk{/snippet}
				</ModalButton>
			</div>
		{/if}
	</Modal>
</div>

<style>
	.shell-pane {
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
