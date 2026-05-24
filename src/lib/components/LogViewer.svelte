<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { onMount } from 'svelte';
	import { clearDebugLogs, getDebugLogs } from '$lib/debug-log';

	type LogTab = 'app' | 'llm' | 'tts' | 'whisper' | 'debug' | 'tools' | 'stats';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	// Stats payload shape returned by the Rust `get_search_stats` command.
	type FailureKey = 'http' | 'rate_limited' | 'parse' | 'empty' | 'network' | 'timeout' | 'other';
	const FAILURE_KEYS: FailureKey[] = [
		'http',
		'rate_limited',
		'parse',
		'empty',
		'network',
		'timeout',
		'other'
	];
	const FAILURE_LABELS: Record<FailureKey, string> = {
		http: 'HTTP',
		rate_limited: 'RateLim',
		parse: 'Parse',
		empty: 'Empty',
		network: 'Net',
		timeout: 'Timeout',
		other: 'Other'
	};

	interface SessionEngine {
		engine: string;
		attempts: number;
		successes: number;
		failures_by_kind: Partial<Record<FailureKey, number>>;
		total_latency_ms: number;
		max_latency_ms: number;
		last_success_at: number | null;
		last_failure_at: number | null;
		first_choice_attempts: number;
		fallback_attempts: number;
		fallback_successes: number;
	}
	interface LifetimeEngine {
		engine: string;
		attempts: number;
		successes: number;
		fail_http: number;
		fail_rate_limited: number;
		fail_parse: number;
		fail_empty: number;
		fail_network: number;
		fail_timeout: number;
		fail_other: number;
		total_latency_ms: number;
		max_latency_ms: number;
		last_success_at: number | null;
		last_failure_at: number | null;
		first_choice_attempts: number;
		fallback_attempts: number;
		fallback_successes: number;
	}
	interface SessionGlobals {
		cache_hits: number;
		total_queries: number;
		all_engines_failed: number;
	}
	interface CombinedStats {
		session: { engines: SessionEngine[]; globals: SessionGlobals };
		lifetime: { engines: LifetimeEngine[]; globals: Record<string, number> };
	}

	interface UnifiedRow {
		engine: string;
		attempts: number;
		successes: number;
		failures: Record<FailureKey, number>;
		total_latency_ms: number;
		max_latency_ms: number;
		last_success_at: number | null;
		last_failure_at: number | null;
		first_choice_attempts: number;
		fallback_attempts: number;
		fallback_successes: number;
	}

	let { open, onclose }: Props = $props();
	let activeTab = $state<LogTab>('app');
	let logLines = $state<string[]>([]);
	let statsData = $state<CombinedStats | null>(null);
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

	const tabCommands: Record<Exclude<LogTab, 'debug' | 'tools' | 'stats'>, string> = {
		app: 'get_app_logs',
		llm: 'get_server_logs',
		tts: 'get_tts_logs',
		whisper: 'get_whisper_logs'
	};

	const clearCommands: Record<Exclude<LogTab, 'debug' | 'tools' | 'stats'>, string> = {
		app: 'clear_app_logs',
		llm: 'clear_server_logs',
		tts: 'clear_tts_logs',
		whisper: 'clear_whisper_logs'
	};

	const tabLabels: Record<LogTab, string> = {
		app: 'App',
		llm: 'LLM',
		tts: 'TTS',
		whisper: 'Whisper',
		debug: 'Debug',
		tools: 'Tools',
		stats: 'Stats'
	};

	async function fetchLogs() {
		try {
			if (activeTab === 'stats') {
				statsData = await invoke<CombinedStats>('get_search_stats');
				return;
			}
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

	function normalizeSession(e: SessionEngine): UnifiedRow {
		const failures: Record<FailureKey, number> = {
			http: e.failures_by_kind.http ?? 0,
			rate_limited: e.failures_by_kind.rate_limited ?? 0,
			parse: e.failures_by_kind.parse ?? 0,
			empty: e.failures_by_kind.empty ?? 0,
			network: e.failures_by_kind.network ?? 0,
			timeout: e.failures_by_kind.timeout ?? 0,
			other: e.failures_by_kind.other ?? 0
		};
		return {
			engine: e.engine,
			attempts: e.attempts,
			successes: e.successes,
			failures,
			total_latency_ms: e.total_latency_ms,
			max_latency_ms: e.max_latency_ms,
			last_success_at: e.last_success_at,
			last_failure_at: e.last_failure_at,
			first_choice_attempts: e.first_choice_attempts,
			fallback_attempts: e.fallback_attempts,
			fallback_successes: e.fallback_successes
		};
	}

	function normalizeLifetime(e: LifetimeEngine): UnifiedRow {
		return {
			engine: e.engine,
			attempts: e.attempts,
			successes: e.successes,
			failures: {
				http: e.fail_http,
				rate_limited: e.fail_rate_limited,
				parse: e.fail_parse,
				empty: e.fail_empty,
				network: e.fail_network,
				timeout: e.fail_timeout,
				other: e.fail_other
			},
			total_latency_ms: e.total_latency_ms,
			max_latency_ms: e.max_latency_ms,
			last_success_at: e.last_success_at,
			last_failure_at: e.last_failure_at,
			first_choice_attempts: e.first_choice_attempts,
			fallback_attempts: e.fallback_attempts,
			fallback_successes: e.fallback_successes
		};
	}

	function pct(num: number, denom: number): string {
		if (denom <= 0) return '—';
		return `${((num / denom) * 100).toFixed(1)}%`;
	}

	function meanMs(row: UnifiedRow): string {
		if (row.successes <= 0) return '—';
		return Math.round(row.total_latency_ms / row.successes).toString();
	}

	function age(ts: number | null): string {
		if (!ts) return 'never';
		const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
		if (s < 60) return `${s}s ago`;
		if (s < 3600) return `${Math.floor(s / 60)}m ago`;
		if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
		return `${Math.floor(s / 86400)}d ago`;
	}

	function lifetimeGlobalsObj(g: Record<string, number>): SessionGlobals {
		return {
			cache_hits: g.cache_hits ?? 0,
			total_queries: g.total_queries ?? 0,
			all_engines_failed: g.all_engines_failed ?? 0
		};
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
	let clearState = $state<'idle' | 'cleared'>('idle');

	async function clearCurrentLog() {
		try {
			if (activeTab === 'stats') {
				if (!confirm('Reset all lifetime search statistics? Session stats are not affected.')) {
					return;
				}
				await invoke('reset_lifetime_search_stats');
				await fetchLogs();
			} else if (activeTab === 'debug' || activeTab === 'tools') {
				// Frontend ring buffer — both tabs read from it; clearing once
				// empties them both.
				clearDebugLogs();
				logLines = [];
			} else {
				await invoke(clearCommands[activeTab]);
				logLines = [];
			}
		} catch (e) {
			console.error('Failed to clear logs:', e);
		}
		clearState = 'cleared';
		setTimeout(() => {
			clearState = 'idle';
		}, 1200);
	}

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
					{#each ['app', 'llm', 'tts', 'whisper', 'debug', 'tools', 'stats'] as const as tab (tab)}
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
						onclick={clearCurrentLog}
						title={activeTab === 'stats'
							? 'Reset lifetime search statistics (session stats are not affected)'
							: 'Clear the in-memory log buffer for this tab'}
					>
						{#if activeTab === 'stats'}
							{clearState === 'cleared' ? 'Reset' : 'Reset lifetime'}
						{:else}
							{clearState === 'cleared' ? 'Cleared' : 'Clear'}
						{/if}
					</button>
					{#if activeTab !== 'stats'}
						<button
							class="copy-btn"
							onclick={copyAllLogs}
							title="Copy current log tab to clipboard for bug reports"
						>
							{copyState === 'copied' ? 'Copied!' : 'Copy all'}
						</button>
					{/if}
					<button class="close-btn" onclick={onclose} title="Close">&times;</button>
				</div>
			</div>
			<div class="log-area" bind:this={logContainer} onscroll={handleScroll}>
				{#snippet engineTable(rows: UnifiedRow[], globals: SessionGlobals)}
					{#if rows.length === 0}
						<div class="stats-empty">No engine activity recorded yet.</div>
					{:else}
						<table class="stats-table">
							<thead>
								<tr>
									<th>Engine</th>
									<th>Att</th>
									<th>OK</th>
									<th>OK%</th>
									<th>Mean ms</th>
									<th>Max ms</th>
									<th>Last OK</th>
									<th>Last fail</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.engine)}
									<tr>
										<td>{r.engine}</td>
										<td>{r.attempts}</td>
										<td>{r.successes}</td>
										<td>{pct(r.successes, r.attempts)}</td>
										<td>{meanMs(r)}</td>
										<td>{r.max_latency_ms || '—'}</td>
										<td>{age(r.last_success_at)}</td>
										<td>{age(r.last_failure_at)}</td>
									</tr>
								{/each}
							</tbody>
						</table>

						<table class="stats-table stats-sub">
							<thead>
								<tr>
									<th>Failures by kind</th>
									{#each FAILURE_KEYS as k (k)}
										<th>{FAILURE_LABELS[k]}</th>
									{/each}
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.engine)}
									<tr>
										<td>{r.engine}</td>
										{#each FAILURE_KEYS as k (k)}
											<td class:zero={r.failures[k] === 0}>{r.failures[k]}</td>
										{/each}
									</tr>
								{/each}
							</tbody>
						</table>

						<table class="stats-table stats-sub">
							<thead>
								<tr>
									<th>Auto-rotate</th>
									<th>First choice</th>
									<th>Fallback</th>
									<th>Fallback recovery%</th>
								</tr>
							</thead>
							<tbody>
								{#each rows as r (r.engine)}
									<tr>
										<td>{r.engine}</td>
										<td>{r.first_choice_attempts}</td>
										<td>{r.fallback_attempts}</td>
										<td>{pct(r.fallback_successes, r.fallback_attempts)}</td>
									</tr>
								{/each}
							</tbody>
						</table>
					{/if}

					<div class="stats-globals">
						<div>Total queries: <b>{globals.total_queries}</b></div>
						<div>
							Cache hits: <b>{globals.cache_hits}</b>
							{#if globals.total_queries > 0}
								<span class="muted">({pct(globals.cache_hits, globals.total_queries)})</span>
							{/if}
						</div>
						<div>All-engines failures: <b>{globals.all_engines_failed}</b></div>
					</div>
				{/snippet}

				{#if activeTab === 'stats'}
					{#if statsData}
						<div class="stats-scope">
							<h3 class="stats-heading">
								Session <span class="muted">(since app start)</span>
							</h3>
							{@render engineTable(
								statsData.session.engines.map(normalizeSession),
								statsData.session.globals
							)}
						</div>
						<div class="stats-scope">
							<h3 class="stats-heading">
								Lifetime <span class="muted">(persisted, all-time)</span>
							</h3>
							{@render engineTable(
								statsData.lifetime.engines.map(normalizeLifetime),
								lifetimeGlobalsObj(statsData.lifetime.globals)
							)}
						</div>
					{:else}
						<div class="log-line log-empty">Loading stats…</div>
					{/if}
				{:else if humanReadable && STRUCTURED_TABS.has(activeTab)}
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

	.stats-scope {
		padding: 8px 0 16px 0;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 50%, transparent);
	}

	.stats-scope:last-child {
		border-bottom: none;
	}

	.stats-heading {
		margin: 4px 0 8px 0;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--accent);
	}

	.stats-heading .muted {
		color: var(--text-secondary);
		font-weight: 400;
		font-size: 0.75rem;
		margin-left: 4px;
	}

	.stats-table {
		width: 100%;
		border-collapse: collapse;
		font-size: 0.72rem;
		margin-bottom: 10px;
	}

	.stats-table.stats-sub {
		margin-top: -4px;
	}

	.stats-table th,
	.stats-table td {
		padding: 3px 8px;
		text-align: right;
		border-bottom: 1px solid color-mix(in srgb, var(--border) 30%, transparent);
	}

	.stats-table th:first-child,
	.stats-table td:first-child {
		text-align: left;
		color: #4ec9b0;
		font-weight: 500;
	}

	.stats-table th {
		color: var(--text-secondary);
		font-weight: 500;
		text-transform: none;
	}

	.stats-table td.zero {
		color: var(--text-secondary);
		opacity: 0.4;
	}

	.stats-empty {
		color: var(--text-secondary);
		font-style: italic;
		padding: 4px 0 12px 0;
	}

	.stats-globals {
		display: flex;
		gap: 18px;
		flex-wrap: wrap;
		padding: 6px 0 0 0;
		font-size: 0.75rem;
		color: var(--text-secondary);
	}

	.stats-globals b {
		color: #d4d4d4;
		font-weight: 600;
	}

	.stats-globals .muted {
		opacity: 0.7;
	}
</style>
