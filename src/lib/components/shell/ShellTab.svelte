<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import Terminal, { type TerminalHandle } from './Terminal.svelte';
	import ChatSidebar from './ChatSidebar.svelte';
	import { getActiveTab } from '$lib/stores/activeTab.svelte';
	import { isShellSubmitting, setShellSidebarOpen, submitShell } from '$lib/stores/shell.svelte';

	interface CapturedRegion {
		commandLine: string;
		output: string;
		exitCode: number | null;
		cwd: string | null;
		truncated: boolean;
	}

	interface ContextResponse {
		context: {
			os: string;
			kernel: string;
			distroId?: string;
			distroName?: string;
			distroVersion?: string;
			shellPath: string;
			shellName: string;
			shellVersion?: string;
			home?: string;
			hostname?: string;
		};
		current_cwd: string | null;
	}

	let handle = $state<TerminalHandle | null>(null);
	let hasSelection = $state(false);
	let menu = $state<{ x: number; y: number } | null>(null);

	const submitting = $derived(isShellSubmitting());

	async function submitToLlm() {
		if (!handle || submitting) return;
		menu = null;

		const selection = hasSelection ? handle.getSelection().trim() : '';
		let body: string;
		let cwd: string | null;
		const ctxRes = await invoke<ContextResponse>('shell_get_context', {
			sessionId: handle.sessionId
		});
		const history = await invoke<string[]>('shell_get_recent_history', {
			sessionId: handle.sessionId,
			limit: 10
		});
		cwd = ctxRes.current_cwd;

		if (selection) {
			body = formatSelectionBody(selection, cwd);
		} else {
			const region = await invoke<CapturedRegion | null>('shell_get_last_command', {
				sessionId: handle.sessionId
			});
			if (!region) {
				setShellSidebarOpen(true);
				return;
			}
			body = formatCapturedRegion(region);
			cwd = region.cwd ?? cwd;
		}

		await submitShell({
			body,
			sessionContext: handle.context,
			currentCwd: cwd,
			recentHistory: history
		});
	}

	function formatCapturedRegion(region: CapturedRegion): string {
		const cmd = region.commandLine.trim() || '(no command captured)';
		const out = region.output.trimEnd();
		const meta = [`exit ${region.exitCode ?? '?'}`];
		if (region.cwd) meta.push(`cwd ${region.cwd}`);
		if (region.truncated) meta.push('truncated');
		return `$ ${cmd}\n${out}\n(${meta.join(', ')})`;
	}

	function formatSelectionBody(text: string, cwd: string | null): string {
		const header = cwd ? `(cwd ${cwd})\n` : '';
		return `${header}${text}`;
	}

	function onKeyDown(event: KeyboardEvent) {
		// Only react when the Shell tab is the active one. Ctrl+Shift+L is
		// global on <svelte:window>, so without this guard it would fire
		// from inside chat or settings.
		if (getActiveTab() !== 'shell') return;
		// Ctrl+Shift+L → submit to LLM. Deliberately Shift to avoid clashing
		// with readline's Ctrl+L clear-screen.
		if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'l') {
			event.preventDefault();
			submitToLlm();
		}
	}

	function onContextMenu(event: MouseEvent) {
		event.preventDefault();
		menu = { x: event.clientX, y: event.clientY };
	}

	function dismissMenu() {
		menu = null;
	}

	onMount(() => {
		window.addEventListener('click', dismissMenu);
		return () => window.removeEventListener('click', dismissMenu);
	});
</script>

<svelte:window onkeydown={onKeyDown} />

<div class="shell-tab" oncontextmenu={onContextMenu} role="presentation">
	<div class="terminal-region">
		<div class="toolbar">
			<button
				class="primary"
				onclick={submitToLlm}
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
			<Terminal onReady={(h) => (handle = h)} onSelectionChange={(has) => (hasSelection = has)} />
		</div>
	</div>
	<ChatSidebar />
	{#if menu}
		<div class="context-menu" style="left: {menu.x}px; top: {menu.y}px" role="menu" tabindex="-1">
			<button onclick={submitToLlm}>Send to LLM</button>
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
