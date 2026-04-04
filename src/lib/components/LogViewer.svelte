<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';

	type SidecarTab = 'llm' | 'tts' | 'whisper';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	let { open, onclose }: Props = $props();
	let activeTab = $state<SidecarTab>('llm');
	let logLines = $state<string[]>([]);
	let logContainer: HTMLDivElement | undefined = $state();
	let pollInterval: ReturnType<typeof setInterval> | null = null;
	let wasAtBottom = true;

	const tabCommands: Record<SidecarTab, string> = {
		llm: 'get_server_logs',
		tts: 'get_tts_logs',
		whisper: 'get_whisper_logs'
	};

	const tabLabels: Record<SidecarTab, string> = {
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

	function switchTab(tab: SidecarTab) {
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
					{#each ['llm', 'tts', 'whisper'] as const as tab (tab)}
						<button class="tab" class:active={activeTab === tab} onclick={() => switchTab(tab)}>
							{tabLabels[tab]}
						</button>
					{/each}
				</div>
				<button class="close-btn" onclick={onclose} title="Close">&times;</button>
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
