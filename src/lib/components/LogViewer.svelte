<script lang="ts">
	import { invoke } from '@tauri-apps/api/core';
	import { IPC } from '$lib/ipc/commands';
	import { onMount } from 'svelte';
	import { dismissable } from '$lib/actions/dismissable';
	import ConfirmDialog from '$lib/components/ConfirmDialog.svelte';
	import { clearDebugLogs, getDebugLogs } from '$lib/debug-log';
	import { createCopyAction } from '$lib/utils/clipboard.svelte';
	import type { CombinedSearchStats } from '$lib/ipc/gen/CombinedSearchStats';
	import type { EngineLifetimeStats } from '$lib/ipc/gen/EngineLifetimeStats';
	import type { EngineSessionStats } from '$lib/ipc/gen/EngineSessionStats';
	import type { GlobalCounters } from '$lib/ipc/gen/GlobalCounters';
	import type { SearchFailureKind } from '$lib/ipc/gen/SearchFailureKind';

	type LogTab = 'app' | 'llm' | 'tts' | 'whisper' | 'crashes' | 'debug' | 'tools' | 'stats';

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	// Stats payload shape returned by the Rust `get_search_stats` command —
	// ts-rs-generated from the Rust structs.
	type FailureKey = SearchFailureKind;
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

	type CombinedStats = CombinedSearchStats;

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
	let filterText = $state('');
	let turnFilter = $state('');
	let categoryFilter = $state('');
	let filterInput: HTMLInputElement | undefined = $state();

	const STRUCTURED_TABS: ReadonlySet<LogTab> = new Set(['debug', 'tools']);
	const PREFIX_RE = /^\[([^\]]+)\](?:\s+\[turn (\d+)\])?\s+\[([^\]]+)\]\s+/;

	const filtersActive = $derived(
		filterText.trim() !== '' || turnFilter !== '' || categoryFilter !== ''
	);

	/**
	 * Turn / category facets, read straight off the line prefix.
	 *
	 * Deliberately uses PREFIX_RE alone rather than `parseLine` — the latter
	 * brute-forces `JSON.parse` at every `{` in the line looking for the data
	 * payload, which is far too costly to run across a full 5000-entry buffer
	 * on every 2s poll. The prefix regex gives us everything the facets need.
	 */
	/** Collect the distinct values of one PREFIX_RE capture group. */
	function distinctPrefixField(group: 2 | 3): string[] {
		const seen: Record<string, true> = {};
		for (const l of logLines) {
			const m = l.match(PREFIX_RE);
			const v = m?.[group];
			if (v) seen[v] = true;
		}
		return Object.keys(seen);
	}

	const availableTurns = $derived(distinctPrefixField(2).sort((a, b) => Number(a) - Number(b)));
	const availableCategories = $derived(distinctPrefixField(3).sort());

	const filteredLines = $derived.by(() => {
		if (!filtersActive) return logLines;
		const needle = filterText.trim().toLowerCase();
		return logLines.filter((l) => {
			if (turnFilter || categoryFilter) {
				const m = l.match(PREFIX_RE);
				if (turnFilter && m?.[2] !== turnFilter) return false;
				if (categoryFilter && m?.[3] !== categoryFilter) return false;
			}
			return !needle || l.toLowerCase().includes(needle);
		});
	});

	function clearFilters() {
		filterText = '';
		turnFilter = '';
		categoryFilter = '';
	}

	function handleKeydown(e: KeyboardEvent) {
		if ((e.ctrlKey || e.metaKey) && e.key === 'f') {
			e.preventDefault();
			filterInput?.focus();
			filterInput?.select();
		}
	}

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

	const tabCommands: Record<Exclude<LogTab, 'crashes' | 'debug' | 'tools' | 'stats'>, string> = {
		app: IPC.get_app_logs,
		llm: IPC.get_server_logs,
		tts: IPC.get_tts_logs,
		whisper: IPC.get_whisper_logs
	};

	const clearCommands: Record<Exclude<LogTab, 'crashes' | 'debug' | 'tools' | 'stats'>, string> = {
		app: IPC.clear_app_logs,
		llm: IPC.clear_server_logs,
		tts: IPC.clear_tts_logs,
		whisper: IPC.clear_whisper_logs
	};

	const tabLabels: Record<LogTab, string> = {
		app: 'App',
		llm: 'LLM',
		tts: 'TTS',
		whisper: 'Whisper',
		crashes: 'Crashes',
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
			if (activeTab === 'crashes') {
				// The crash telemetry is a single multi-line file, not a ring
				// buffer of lines — fetch the whole thing and split for display.
				const text = await invoke<string>('get_llama_crash_log');
				logLines = text ? text.replace(/\n$/, '').split('\n') : [];
			} else if (activeTab === 'debug') {
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

	function normalizeSession(e: EngineSessionStats): UnifiedRow {
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

	function normalizeLifetime(e: EngineLifetimeStats): UnifiedRow {
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

	function lifetimeGlobalsObj(g: CombinedSearchStats['lifetime']['globals']): GlobalCounters {
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
		// Turn/category ids don't carry across tabs, so a stale facet would
		// silently filter everything out. Free-text search is kept — searching
		// the same string across tabs is a normal thing to want.
		turnFilter = '';
		categoryFilter = '';
		startPolling();
	}

	const copyLogs = createCopyAction();
	let clearState = $state<'idle' | 'cleared'>('idle');
	// Lifetime stats reset awaits ConfirmDialog approval.
	let confirmingStatsReset = $state(false);

	function markCleared() {
		clearState = 'cleared';
		setTimeout(() => {
			clearState = 'idle';
		}, 1200);
	}

	async function resetLifetimeStats() {
		confirmingStatsReset = false;
		try {
			await invoke('reset_lifetime_search_stats');
			await fetchLogs();
		} catch (e) {
			console.error('Failed to reset lifetime search stats:', e);
		}
		markCleared();
	}

	async function clearCurrentLog() {
		if (activeTab === 'stats') {
			confirmingStatsReset = true;
			return;
		}
		try {
			if (activeTab === 'crashes') {
				await invoke('clear_llama_crash_log');
				logLines = [];
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
		markCleared();
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

{#if open}
	<!-- While the reset confirmation is up, Esc should cancel only the
	     dialog (its own dismissable handles that), not close the viewer. -->
	<div
		class="backdrop"
		use:dismissable={() => {
			if (!confirmingStatsReset) onclose();
		}}
	>
		<div class="modal" role="dialog" tabindex="-1" onkeydown={handleKeydown}>
			<div class="modal-header">
				<div class="tabs">
					{#each ['app', 'llm', 'tts', 'whisper', 'crashes', 'debug', 'tools', 'stats'] as const as tab (tab)}
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
							onclick={() => copyLogs.copy(filteredLines.join('\n'))}
							title={filtersActive
								? 'Copy the filtered lines to clipboard'
								: 'Copy current log tab to clipboard for bug reports'}
						>
							{copyLogs.state === 'copied'
								? 'Copied!'
								: filtersActive
									? `Copy ${filteredLines.length}`
									: 'Copy all'}
						</button>
					{/if}
					<button class="modal-close" onclick={onclose} title="Close">&times;</button>
				</div>
			</div>
			{#if activeTab !== 'stats'}
				<div class="filter-bar">
					<input
						class="filter-input"
						type="text"
						placeholder="Find in log…"
						bind:this={filterInput}
						bind:value={filterText}
					/>
					{#if STRUCTURED_TABS.has(activeTab)}
						<select class="filter-select" bind:value={turnFilter} title="Filter by agent turn">
							<option value="">All turns</option>
							{#each availableTurns as t (t)}
								<option value={t}>turn {t}</option>
							{/each}
						</select>
						<select class="filter-select" bind:value={categoryFilter} title="Filter by category">
							<option value="">All categories</option>
							{#each availableCategories as c (c)}
								<option value={c}>{c}</option>
							{/each}
						</select>
					{/if}
					{#if filtersActive}
						<span class="filter-count">{filteredLines.length} / {logLines.length}</span>
						<button class="filter-clear" onclick={clearFilters} title="Clear filters">Clear</button>
					{/if}
				</div>
			{/if}
			<div class="log-area" bind:this={logContainer} onscroll={handleScroll}>
				{#snippet engineTable(rows: UnifiedRow[], globals: GlobalCounters)}
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
					{#each filteredLines as line, i (`${activeTab}-${i}`)}
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
						<div class="log-line log-empty">
							{filtersActive ? 'No lines match the filter.' : 'No log output yet.'}
						</div>
					{/each}
				{:else}
					{#each filteredLines as line, i (`${activeTab}-${i}`)}
						<div class="log-line">{line}</div>
					{:else}
						<div class="log-line log-empty">
							{filtersActive ? 'No lines match the filter.' : 'No log output yet.'}
						</div>
					{/each}
				{/if}
			</div>
		</div>
	</div>

	<ConfirmDialog
		open={confirmingStatsReset}
		title="Reset search statistics?"
		message="Reset all lifetime search statistics? Session stats are not affected."
		confirmLabel="Reset"
		onconfirm={resetLifetimeStats}
		oncancel={() => (confirmingStatsReset = false)}
	/>
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

	.filter-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 6px 12px;
		border-bottom: 1px solid var(--border);
		flex-shrink: 0;
	}

	.filter-input {
		flex: 1;
		min-width: 0;
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 5px 10px;
		color: var(--text-primary);
		font-size: 0.75rem;
		font-family: inherit;
	}

	.filter-input:focus {
		outline: none;
		border-color: var(--accent);
	}

	.filter-select {
		background: var(--bg-secondary);
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 5px 8px;
		color: var(--text-secondary);
		font-size: 0.75rem;
		font-family: inherit;
		cursor: pointer;
		max-width: 140px;
	}

	.filter-count {
		color: var(--text-secondary);
		font-size: 0.72rem;
		white-space: nowrap;
		font-variant-numeric: tabular-nums;
	}

	.filter-clear {
		background: none;
		border: 1px solid var(--border);
		border-radius: 6px;
		padding: 4px 10px;
		cursor: pointer;
		color: var(--text-secondary);
		font-size: 0.72rem;
	}

	.filter-clear:hover {
		color: var(--text-primary);
		border-color: var(--text-secondary);
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
