/**
 * In-app feedback / diagnostics helpers.
 *
 * Two user-facing flows:
 *   - `openFeedbackIssue` — opens a pre-filled GitHub issue in the
 *     user's browser. Fields are populated from app state via the
 *     `get_diagnostics` Tauri command + frontend settings. The user
 *     reviews and submits in their own GitHub session — no token, no
 *     server.
 *   - `saveFullDiagnostics` — writes the untruncated bundle (including
 *     all logs) to a user-chosen file path so they can drag it onto the
 *     issue if the URL-prefilled fields aren't enough.
 *
 * Logs are intentionally NOT included in the issue URL — they're rarely
 * useful at the truncation budget GitHub permits, and dragging the full
 * bundle in is a better workflow when they're actually needed. Search
 * statistics (session) are small enough to fit and are diagnostic for
 * the search-rotation behavior, so those go in the URL.
 */

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { getSettings } from '$lib/stores/settings';
import { getDebugLogs } from '$lib/debug-log';

const REPO = 'tmac1973/haruspex';
const ISSUE_URL_BASE = `https://github.com/${REPO}/issues/new`;
const TEMPLATE = 'feedback.yml';

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

interface SessionEngineStats {
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

interface LifetimeEngineStats {
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

interface RustDiagnostics {
	app_version: string;
	os: string;
	arch: string;
	appimage: boolean;
	app_log: string[];
	llama_log: string[];
	whisper_log: string[];
	tts_log: string[];
	search_stats: {
		session: {
			engines: SessionEngineStats[];
			globals: SessionGlobals;
		};
		lifetime: {
			engines: LifetimeEngineStats[];
			globals: Record<string, number>;
		};
	};
}

export interface Diagnostics extends RustDiagnostics {
	debug_log: string[];
}

export async function gatherDiagnostics(): Promise<Diagnostics> {
	const rust = await invoke<RustDiagnostics>('get_diagnostics');
	return { ...rust, debug_log: getDebugLogs() };
}

function buildSystemBlock(d: Diagnostics): string {
	const lines = [`Haruspex ${d.app_version}`, `OS:   ${d.os}`, `Arch: ${d.arch}`];
	if (d.appimage) lines.push('Packaging: AppImage');
	return lines.join('\n');
}

/**
 * Subset of settings worth including in a bug report, with credentials
 * stripped. Pulled from the localStorage store synchronously.
 */
function buildSettingsSnapshot(): string {
	const s = getSettings();
	const inf = s.inferenceBackend;
	const snapshot = {
		responseFormat: s.responseFormat,
		theme: s.theme,
		contextSize: s.contextSize,
		thinkingEnabled: s.thinkingEnabled,
		hasCustomSystemPrompt: s.customSystemPrompt.length > 0,
		customSystemPromptLength: s.customSystemPrompt.length,
		sandboxEnabled: s.sandboxEnabled,
		sandboxApproval: s.sandboxApproval,
		sandboxTimeoutSeconds: s.sandboxTimeoutSeconds,
		keepRecentToolResults: s.keepRecentToolResults,
		activeLocalModelFilename: s.activeLocalModelFilename,
		inferenceBackend: {
			mode: inf.mode,
			remoteBaseUrl: inf.remoteBaseUrl,
			remoteModelId: inf.remoteModelId,
			remoteContextSize: inf.remoteContextSize,
			remoteVisionSupported: inf.remoteVisionSupported,
			remoteBackendKind: inf.remoteBackendKind,
			remoteApiKeyConfigured: inf.remoteApiKey.length > 0
		},
		searchProvider: s.searchProvider,
		searxngUrl: s.searxngUrl,
		braveApiKeyConfigured: s.braveApiKey.length > 0,
		ttsVoice: s.ttsVoice,
		ttsReadTablesByColumn: s.ttsReadTablesByColumn,
		audioOutputDevice: s.audioOutputDevice,
		audioInputDevice: s.audioInputDevice,
		proxy: { mode: s.proxy.mode, hasUrl: s.proxy.url.length > 0 },
		emailAccountCount: s.integrations.email.accounts.length,
		emailEnabledCount: s.integrations.email.accounts.filter((a) => a.enabled).length
	};
	return JSON.stringify(snapshot, null, 2);
}

interface UnifiedStatsRow {
	engine: string;
	attempts: number;
	successes: number;
	failures: Record<FailureKey, number>;
	totalLatencyMs: number;
	maxLatencyMs: number;
	lastSuccessAt: number | null;
	lastFailureAt: number | null;
	firstChoiceAttempts: number;
	fallbackAttempts: number;
	fallbackSuccesses: number;
}

function fromSession(e: SessionEngineStats): UnifiedStatsRow {
	return {
		engine: e.engine,
		attempts: e.attempts,
		successes: e.successes,
		failures: {
			http: e.failures_by_kind.http ?? 0,
			rate_limited: e.failures_by_kind.rate_limited ?? 0,
			parse: e.failures_by_kind.parse ?? 0,
			empty: e.failures_by_kind.empty ?? 0,
			network: e.failures_by_kind.network ?? 0,
			timeout: e.failures_by_kind.timeout ?? 0,
			other: e.failures_by_kind.other ?? 0
		},
		totalLatencyMs: e.total_latency_ms,
		maxLatencyMs: e.max_latency_ms,
		lastSuccessAt: e.last_success_at,
		lastFailureAt: e.last_failure_at,
		firstChoiceAttempts: e.first_choice_attempts,
		fallbackAttempts: e.fallback_attempts,
		fallbackSuccesses: e.fallback_successes
	};
}

function fromLifetime(e: LifetimeEngineStats): UnifiedStatsRow {
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
		totalLatencyMs: e.total_latency_ms,
		maxLatencyMs: e.max_latency_ms,
		lastSuccessAt: e.last_success_at,
		lastFailureAt: e.last_failure_at,
		firstChoiceAttempts: e.first_choice_attempts,
		fallbackAttempts: e.fallback_attempts,
		fallbackSuccesses: e.fallback_successes
	};
}

function lifetimeGlobals(g: Record<string, number>): SessionGlobals {
	return {
		cache_hits: g.cache_hits ?? 0,
		total_queries: g.total_queries ?? 0,
		all_engines_failed: g.all_engines_failed ?? 0
	};
}

function ageString(ts: number | null): string {
	if (!ts) return 'never';
	const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
	if (s < 60) return `${s}s`;
	if (s < 3600) return `${Math.floor(s / 60)}m`;
	if (s < 86400) return `${Math.floor(s / 3600)}h`;
	return `${Math.floor(s / 86400)}d`;
}

function pad(s: string | number, w: number, right = false): string {
	const str = String(s);
	if (str.length >= w) return str;
	const fill = ' '.repeat(w - str.length);
	return right ? fill + str : str + fill;
}

/**
 * Format a single scope (session or lifetime) of search stats as a
 * compact monospace text block — fits readably in a GitHub issue's
 * `render: shell` textarea.
 */
function formatStatsScope(rows: UnifiedStatsRow[], globals: SessionGlobals): string {
	const out: string[] = [];
	out.push(
		`queries=${globals.total_queries} cache_hits=${globals.cache_hits} all_engines_failed=${globals.all_engines_failed}`
	);

	if (rows.length === 0) {
		out.push('(no engine activity)');
		return out.join('\n');
	}

	const engineColW = Math.max(8, ...rows.map((r) => r.engine.length));
	out.push('');
	out.push(
		[
			pad('engine', engineColW),
			pad('att', 4, true),
			pad('ok', 4, true),
			pad('ok%', 6, true),
			pad('mean', 6, true),
			pad('max', 6, true),
			pad('lastOK', 7),
			'failures'
		].join('  ')
	);
	for (const r of rows) {
		const okPct = r.attempts > 0 ? `${((r.successes / r.attempts) * 100).toFixed(1)}%` : '—';
		const meanMs = r.successes > 0 ? Math.round(r.totalLatencyMs / r.successes) : '—';
		const failParts = FAILURE_KEYS.filter((k) => r.failures[k] > 0).map(
			(k) => `${k}:${r.failures[k]}`
		);
		out.push(
			[
				pad(r.engine, engineColW),
				pad(r.attempts, 4, true),
				pad(r.successes, 4, true),
				pad(okPct, 6, true),
				pad(meanMs, 6, true),
				pad(r.maxLatencyMs || '—', 6, true),
				pad(ageString(r.lastSuccessAt), 7),
				failParts.join(', ') || '—'
			].join('  ')
		);
	}

	// Auto-rotate breakdown only if any engine has auto-rotate activity.
	const hasAuto = rows.some((r) => r.firstChoiceAttempts > 0 || r.fallbackAttempts > 0);
	if (hasAuto) {
		out.push('');
		out.push('auto-rotate (first / fallback (recovered)):');
		for (const r of rows) {
			if (r.firstChoiceAttempts === 0 && r.fallbackAttempts === 0) continue;
			const rec = r.fallbackAttempts > 0 ? ` (${r.fallbackSuccesses})` : '';
			out.push(
				`  ${pad(r.engine, engineColW)} ${pad(r.firstChoiceAttempts, 3, true)} / ${pad(
					r.fallbackAttempts,
					3,
					true
				)}${rec}`
			);
		}
	}

	return out.join('\n');
}

function buildSessionStatsBlock(d: Diagnostics): string {
	const rows = d.search_stats.session.engines.map(fromSession);
	return formatStatsScope(rows, d.search_stats.session.globals);
}

function buildLifetimeStatsBlock(d: Diagnostics): string {
	const rows = d.search_stats.lifetime.engines.map(fromLifetime);
	return formatStatsScope(rows, lifetimeGlobals(d.search_stats.lifetime.globals));
}

/**
 * Compose the pre-filled GitHub issue URL. Includes version, system
 * info, settings (with secrets stripped), and session search stats.
 * Logs are intentionally omitted — they rarely fit and rarely help at
 * the truncation budget; users can attach the full bundle separately.
 */
export function buildFeedbackUrl(d: Diagnostics): string {
	const params = new URLSearchParams({
		template: TEMPLATE,
		version: d.app_version,
		system: buildSystemBlock(d),
		settings: buildSettingsSnapshot(),
		stats: buildSessionStatsBlock(d)
	});
	return `${ISSUE_URL_BASE}?${params.toString()}`;
}

/**
 * Gather diagnostics, build the pre-filled GitHub issue URL, and open
 * it in the user's browser.
 */
export async function openFeedbackIssue(): Promise<void> {
	const diag = await gatherDiagnostics();
	const url = buildFeedbackUrl(diag);
	await invoke('open_url', { url });
}

/**
 * Compose the full unabbreviated diagnostics bundle as a single markdown
 * document. This is what `saveFullDiagnostics` writes to disk; the user
 * can review and drag-attach it to the GitHub issue.
 */
export function buildFullBundle(d: Diagnostics): string {
	const ts = new Date().toISOString();
	return [
		`# Haruspex diagnostics`,
		``,
		`Generated: ${ts}`,
		``,
		`## System`,
		'```',
		buildSystemBlock(d),
		'```',
		``,
		`## Settings`,
		'```json',
		buildSettingsSnapshot(),
		'```',
		``,
		`## Search stats — session (since app start)`,
		'```',
		buildSessionStatsBlock(d),
		'```',
		``,
		`## Search stats — lifetime (persisted)`,
		'```',
		buildLifetimeStatsBlock(d),
		'```',
		``,
		`## App log (${d.app_log.length} lines)`,
		'```',
		d.app_log.join('\n'),
		'```',
		``,
		`## Debug log — agent loop (${d.debug_log.length} lines)`,
		'```',
		d.debug_log.join('\n'),
		'```',
		``,
		`## llama-server (${d.llama_log.length} lines)`,
		'```',
		d.llama_log.join('\n'),
		'```',
		``,
		`## whisper-server (${d.whisper_log.length} lines)`,
		'```',
		d.whisper_log.join('\n'),
		'```',
		``,
		`## koko / tts (${d.tts_log.length} lines)`,
		'```',
		d.tts_log.join('\n'),
		'```',
		''
	].join('\n');
}

/**
 * Result of an attempt to save the diagnostics bundle.
 *   - `saved`: written successfully; `path` is the destination.
 *   - `cancelled`: user dismissed the save dialog.
 */
export type SaveResult = { kind: 'saved'; path: string } | { kind: 'cancelled' };

export async function saveFullDiagnostics(): Promise<SaveResult> {
	const diag = await gatherDiagnostics();
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const defaultName = `haruspex-diagnostics-${stamp}.md`;

	const chosen = await save({
		title: 'Save Haruspex diagnostics',
		defaultPath: defaultName,
		filters: [{ name: 'Markdown', extensions: ['md'] }]
	});
	if (!chosen) return { kind: 'cancelled' };

	const bundle = buildFullBundle(diag);
	await invoke('save_diagnostics_file', { path: chosen, contents: bundle });
	return { kind: 'saved', path: chosen };
}
