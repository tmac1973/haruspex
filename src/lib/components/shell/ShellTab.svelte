<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import Terminal, { type TerminalHandle } from './Terminal.svelte';

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
	let debugText = $state('');
	let debugTitle = $state('');
	let debugVisible = $state(false);

	function showDebug(title: string, text: string) {
		debugTitle = title;
		debugText = text || '(empty)';
		debugVisible = true;
	}

	async function submitForReview() {
		if (!handle) return;
		if (hasSelection) {
			showDebug('Submit (selection)', handle.getSelection());
			return;
		}
		const region = await invoke<CapturedRegion | null>('shell_get_last_command', {
			sessionId: handle.sessionId
		});
		if (!region) {
			showDebug(
				'Submit (last command)',
				'(no completed command yet — run something at the prompt)'
			);
			return;
		}
		const body =
			`$ ${region.commandLine.trim()}\n` +
			`${region.output}\n` +
			`(exit ${region.exitCode ?? '?'}, cwd ${region.cwd ?? '?'}${region.truncated ? ', truncated' : ''})`;
		showDebug('Submit (last command)', body);
	}

	async function showContext() {
		if (!handle) return;
		const r = await invoke<ContextResponse>('shell_get_context', {
			sessionId: handle.sessionId
		});
		showDebug('Session context', JSON.stringify(r, null, 2));
	}

	async function showHistory() {
		if (!handle) return;
		const r = await invoke<string[]>('shell_get_recent_history', {
			sessionId: handle.sessionId,
			limit: 10
		});
		showDebug('Recent history', r.length ? r.join('\n') : '(none)');
	}
</script>

<div class="shell-tab">
	<div class="toolbar">
		<button class="primary" onclick={submitForReview} disabled={!handle}>
			{hasSelection ? 'Submit selection' : 'Submit last command'}
		</button>
		<button onclick={showContext} disabled={!handle}>Context</button>
		<button onclick={showHistory} disabled={!handle}>History</button>
	</div>
	<div class="terminal-pane">
		<Terminal onReady={(h) => (handle = h)} onSelectionChange={(has) => (hasSelection = has)} />
	</div>
	{#if debugVisible}
		<button
			type="button"
			class="debug-backdrop"
			aria-label="Close debug overlay"
			onclick={() => (debugVisible = false)}
		></button>
		<div class="debug-overlay" role="dialog" aria-labelledby="debug-title">
			<header>
				<h3 id="debug-title">{debugTitle}</h3>
				<button onclick={() => (debugVisible = false)}>Close</button>
			</header>
			<pre>{debugText}</pre>
		</div>
	{/if}
</div>

<style>
	.shell-tab {
		display: flex;
		flex-direction: column;
		flex: 1 1 auto;
		min-height: 0;
		overflow: hidden;
		position: relative;
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
		padding: 4px 10px;
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

	.debug-backdrop {
		position: absolute;
		inset: 0;
		background: rgba(0, 0, 0, 0.4);
		border: 0;
		padding: 0;
		cursor: pointer;
		z-index: 1;
	}

	.debug-overlay {
		position: absolute;
		top: 20%;
		left: 10%;
		right: 10%;
		bottom: 10%;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 6px;
		display: flex;
		flex-direction: column;
		box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
		z-index: 2;
		overflow: hidden;
	}

	.debug-overlay header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
	}

	.debug-overlay h3 {
		margin: 0;
		font-size: 0.9rem;
	}

	.debug-overlay button {
		appearance: none;
		background: none;
		border: 1px solid var(--border);
		color: var(--text-primary);
		padding: 3px 10px;
		border-radius: 4px;
		cursor: pointer;
		font-size: 0.8rem;
	}

	.debug-overlay pre {
		flex: 1 1 auto;
		margin: 0;
		padding: 12px;
		overflow: auto;
		font-family: ui-monospace, Menlo, Monaco, 'Cascadia Mono', 'Courier New', monospace;
		font-size: 0.8rem;
		white-space: pre-wrap;
		word-break: break-word;
	}
</style>
