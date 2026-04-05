<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';

	type LogTab = 'app' | 'llm' | 'tts' | 'whisper';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();
	let activeTab = $state<LogTab>('app');
	let logLines = $state<string[]>([]);
	let logContainer: HTMLDivElement | undefined = $state();
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let wasAtBottom = true;

	const tabCommands: Record<LogTab, string> = {
		app: 'get_app_logs',
		llm: 'get_server_logs',
		tts: 'get_tts_logs',
		whisper: 'get_whisper_logs'
	};

	const tabLabels: Record<LogTab, string> = {
		app: 'App',
		llm: 'LLM',
		tts: 'TTS',
		whisper: 'Whisper'
	};

	async function fetchLogs() {
		try {
			logLines = await invoke<string[]>(tabCommands[activeTab]);
			if (wasAtBottom && logContainer) {
				requestAnimationFrame(() => {
					if (logContainer) {
						logContainer.scrollTop = logContainer.scrollHeight;
					}
				});
			}
		} catch {
			// ignore
		}
	}

	function startPolling() {
		stopPolling();
		fetchLogs();
		pollInterval = setInterval(fetchLogs, 2000);
	}

	function stopPolling() {
		if (pollInterval) {
			clearInterval(pollInterval);
			pollInterval = null;
		}
	}

	function handleScroll() {
		if (!logContainer) return;
		wasAtBottom =
			logContainer.scrollHeight - logContainer.scrollTop - logContainer.clientHeight < 30;
	}

	function switchTab(tab: LogTab) {
		activeTab = tab;
		logLines = [];
		wasAtBottom = true;
		startPolling();
	}

	function handleBackdropMousedown(e: MouseEvent) {
		if (e.target === e.currentTarget) {
			onclose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		}
	}

	let copyState = $state<'idle' | 'copied'>('idle');

	async function copyAllLogs() {
		const text = logLines.join('\n');
		try {
			await navigator.clipboard.writeText(text);
			copyState = 'copied';
			setTimeout(() => {
				copyState = 'idle';
			}, 1500);
		} catch (e) {
			console.error('Failed to copy logs:', e);
		}
	}

	$effect(() => {
		if (open) {
			startPolling();
		} else {
			stopPolling();
		}
	});

	onMount(() => {
		return () => stopPolling();
	});
</script>

<svelte:window onkeydown={handleKeydown} />

{#if open}
	<!-- svelte-ignore a11y_no_static_element_interactions -->
	<div class="backdrop" onmousedown={handleBackdropMousedown}>
		<div class="modal">
			<div class="modal-header">
				<div class="tabs">
					{#each ['app', 'llm', 'tts', 'whisper'] as const as tab (tab)}
						<button class="tab" class:active={activeTab === tab} onclick={() => switchTab(tab)}>
							{tabLabels[tab]}
						</button>
					{/each}
				</div>
				<div class="header-actions">
					<button
						class="copy-btn"
						onclick={copyAllLogs}
						title="Copy current log tab to clipboard for bug reports"
					>
						{copyState === 'copied' ? 'Copied!' : 'Copy all'}
					</button>
					<button class="close-btn" onclick={onclose} title="Close">&times;</button>
				</div>
			</div>
			<div class="log-area" bind:this={logContainer} onscroll={handleScroll}>
				{#each logLines as line, i (`${activeTab}-${i}`)}
					<div class="log-line">{line}</div>
				{:else}
					<div class="log-line log-empty">No log output yet.</div>
				{/each}
			</div>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.5);
		z-index: 100;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.modal {
		width: min(80vw, 900px);
		height: 70vh;
		background: var(--bg-primary);
		border: 1px solid var(--border);
		border-radius: 10px;
		display: flex;
		flex-direction: column;
		overflow: hidden;
	}

	.modal-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 8px 12px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.tabs {
		display: flex;
		gap: 4px;
	}

	.tab {
		background: none;
		border: 1px solid transparent;
		border-radius: 6px;
		padding: 6px 14px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.8rem;
		font-weight: 500;
	}

	.tab:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
	}

	.tab.active {
		color: var(--accent);
		border-color: var(--accent);
		background: color-mix(in srgb, var(--accent) 10%, transparent);
	}

	.header-actions {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.copy-btn {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 5px 12px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.copy-btn:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.close-btn {
		background: none;
		border: none;
		font-size: 1.4rem;
		cursor: pointer;
		color: var(--text-secondary);
		padding: 4px 8px;
		line-height: 1;
		border-radius: 4px;
	}

	.close-btn:hover {
		color: var(--text-primary);
		background: var(--bg-secondary);
	}

	.log-area {
		flex: 1;
		overflow-y: auto;
		background: var(--code-bg);
		padding: 8px 12px;
		font-family: 'SF Mono', 'Fira Code', 'Consolas', monospace;
		font-size: 0.7rem;
		line-height: 1.5;
	}

	.log-line {
		color: #d4d4d4;
		white-space: pre-wrap;
		word-break: break-all;
	}

	.log-empty {
		color: var(--text-secondary);
		font-style: italic;
	}
</style>
