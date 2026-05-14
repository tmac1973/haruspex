<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { getDebugLogs } from '$lib/debug-log';

	type LogTab = 'app' | 'llm' | 'tts' | 'whisper' | 'debug' | 'tools';

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
	let humanReadable = $state(false);

	const STRUCTURED_TABS: ReadonlySet<LogTab> = new Set(['debug', 'tools']);
	const PREFIX_RE = /^\[([^\]]+)\](?:\s+\[turn (\d+)\])?\s+\[([^\]]+)\]\s+/;

	interface ParsedLine {
		timestamp?: string;
		turn?: string;
		category?: string;
		message?: string;
		pretty?: string;
	}

	function parseLine(raw: string): ParsedLine {
		const m = raw.match(PREFIX_RE);
		if (!m) return {};
		const rest = raw.slice(m[0].length);
		// The structured logger appends JSON-serialized data after the
		// message text. Walk forward to the first { or [ that successfully
		// parses to the end of the line — message text may itself contain
		// stray brackets, so the first one isn't always the right anchor.
		for (let i = 0; i < rest.length; i++) {
			const ch = rest[i];
			if (ch !== '{' && ch !== '[') continue;
			try {
				const parsed = JSON.parse(rest.slice(i));
				return {
					timestamp: m[1],
					turn: m[2],
					category: m[3],
					message: rest.slice(0, i).trimEnd(),
					pretty: JSON.stringify(parsed, null, 2)
				};
			} catch {
				// keep scanning
			}
		}
		return { timestamp: m[1], turn: m[2], category: m[3], message: rest };
	}

	function formatTimestamp(iso: string): string {
		// `2026-05-13T12:34:56.789Z` → `12:34:56.789`
		const t = iso.indexOf('T');
		const z = iso.lastIndexOf('Z');
		if (t < 0) return iso;
		return iso.slice(t + 1, z > t ? z : undefined);
	}

	const tabCommands: Record<Exclude<LogTab, 'debug' | 'tools'>, string> = {
		app: 'get_app_logs',
		llm: 'get_server_logs',
		tts: 'get_tts_logs',
		whisper: 'get_whisper_logs'
	};

	const tabLabels: Record<LogTab, string> = {
		app: 'App',
		llm: 'LLM',
		tts: 'TTS',
		whisper: 'Whisper',
		debug: 'Debug',
		tools: 'Tools'
	};

	async function fetchLogs() {
		try {
			if (activeTab === 'debug') {
				// Frontend-side ring buffer; no Tauri round-trip needed.
				logLines = getDebugLogs();
			} else if (activeTab === 'tools') {
				// Same buffer, narrowed to tool start/end lines so you can
				// see exactly what arguments the model passed to each tool
				// without scrolling past API and loop chatter.
				logLines = getDebugLogs().filter((l) => /\[agent\] tool (start|end):/.test(l));
			} else {
				logLines = await invoke<string[]>(tabCommands[activeTab]);
			}
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
					{#each ['app', 'llm', 'tts', 'whisper', 'debug', 'tools'] as const as tab (tab)}
						<button class="tab" class:active={activeTab === tab} onclick={() => switchTab(tab)}>
							{tabLabels[tab]}
						</button>
					{/each}
				</div>
				<div class="header-actions">
					{#if STRUCTURED_TABS.has(activeTab)}
						<button
							class="toggle-btn"
							class:active={humanReadable}
							onclick={() => (humanReadable = !humanReadable)}
							title="Toggle pretty formatting (raw is best for copy/paste)"
						>
							{humanReadable ? 'Pretty' : 'Raw'}
						</button>
					{/if}
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
				{#if humanReadable && STRUCTURED_TABS.has(activeTab)}
					{#each logLines as line, i (`${activeTab}-${i}`)}
						{@const parsed = parseLine(line)}
						{#if parsed.timestamp}
							<div class="log-entry">
								<div class="entry-header">
									<span class="ts">{formatTimestamp(parsed.timestamp)}</span>
									{#if parsed.turn}<span class="turn">turn {parsed.turn}</span>{/if}
									<span class="cat">{parsed.category}</span>
								</div>
								{#if parsed.message}
									<div class="entry-message">{parsed.message}</div>
								{/if}
								{#if parsed.pretty}
									<pre class="entry-data">{parsed.pretty}</pre>
								{/if}
							</div>
						{:else}
							<div class="log-entry"><div class="entry-message">{line}</div></div>
						{/if}
					{:else}
						<div class="log-line log-empty">No log output yet.</div>
					{/each}
				{:else}
					{#each logLines as line, i (`${activeTab}-${i}`)}
						<div class="log-line">{line}</div>
					{:else}
						<div class="log-line log-empty">No log output yet.</div>
					{/each}
				{/if}
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

	.copy-btn,
	.toggle-btn {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 5px 12px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-weight: 500;
	}

	.copy-btn:hover,
	.toggle-btn:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
	}

	.toggle-btn.active {
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

	.log-entry {
		padding: 8px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
	}

	.log-entry:last-child {
		border-bottom: none;
	}

	.entry-header {
		display: flex;
		gap: 8px;
		align-items: baseline;
		margin-bottom: 4px;
		font-size: 0.7rem;
	}

	.entry-header .ts {
		color: var(--text-secondary);
	}

	.entry-header .turn {
		color: var(--accent);
	}

	.entry-header .cat {
		color: #4ec9b0;
		font-weight: 600;
	}

	.entry-message {
		color: #d4d4d4;
		white-space: pre-wrap;
		word-break: break-word;
		margin-bottom: 4px;
	}

	.entry-data {
		margin: 0;
		padding: 6px 8px;
		background: color-mix(in srgb, #000 25%, var(--code-bg));
		border-radius: 4px;
		color: #ce9178;
		font-family: inherit;
		font-size: inherit;
		white-space: pre-wrap;
		word-break: break-word;
		overflow-x: auto;
	}
</style>
