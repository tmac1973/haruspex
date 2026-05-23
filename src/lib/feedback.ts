/**
 * In-app feedback / diagnostics helpers.
 *
 * Two user-facing flows:
 *   - `openFeedbackIssue` — opens a pre-filled GitHub issue in the
 *     user's browser. Fields are populated from app state via the
 *     `get_diagnostics` Tauri command + frontend settings + the
 *     frontend debug-log ring buffer. The user reviews and submits in
 *     their own GitHub session — no token, no server.
 *   - `saveFullDiagnostics` — writes the untruncated bundle to a
 *     user-chosen file path so they can drag it onto the issue when
 *     the URL-budget version isn't enough.
 *
 * The URL budget is the tricky part: GitHub's new-issue URL caps out
 * somewhere around 8 KB. Settings snapshot + system info + version are
 * all small; logs are the variable. We compute the budget left over
 * for the logs field and truncate to fit; if there's not enough room
 * for a useful tail (under MIN_LOG_BYTES), we replace the logs field
 * with a pointer to the "Save Full Diagnostics" button.
 */

import { invoke } from '@tauri-apps/api/core';
import { save } from '@tauri-apps/plugin-dialog';
import { getSettings } from '$lib/stores/settings';
import { getDebugLogs } from '$lib/debug-log';

const REPO = 'tmac1973/haruspex';
const ISSUE_URL_BASE = `https://github.com/${REPO}/issues/new`;
const TEMPLATE = 'feedback.yml';

/** Conservative cap — GitHub rejects somewhere around 8 KB. */
const URL_BUDGET = 7000;
/** Below this, the logs tail is too short to be useful; drop it and point at the file export. */
const MIN_LOG_BYTES = 800;

interface RustDiagnostics {
	app_version: string;
	os: string;
	arch: string;
	appimage: boolean;
	app_log: string[];
	llama_log: string[];
	whisper_log: string[];
	tts_log: string[];
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

/**
 * Interleave the four log sources into a single block prefixed by source.
 * Returns the FULL combined text; callers truncate from the front as
 * needed to keep the most recent lines.
 */
function buildLogsBlock(d: Diagnostics): string {
	const sections: string[] = [];
	const add = (label: string, lines: string[]) => {
		if (lines.length === 0) return;
		sections.push(`--- ${label} (${lines.length} lines) ---\n${lines.join('\n')}`);
	};
	add('app log', d.app_log);
	add('debug log (agent loop)', d.debug_log);
	add('llama-server', d.llama_log);
	add('whisper-server', d.whisper_log);
	add('koko (tts)', d.tts_log);
	return sections.join('\n\n');
}

/**
 * Keep only the last `maxBytes` of a string, preserving whole lines and
 * prefixing a "[truncated …]" marker so the reader knows what they're
 * looking at. Returns the input untouched when it already fits.
 */
function tailBytes(text: string, maxBytes: number): string {
	if (text.length <= maxBytes) return text;
	const slice = text.slice(text.length - maxBytes);
	const firstNewline = slice.indexOf('\n');
	const trimmed = firstNewline >= 0 ? slice.slice(firstNewline + 1) : slice;
	return `[truncated — showing last ~${maxBytes} chars]\n${trimmed}`;
}

interface FeedbackUrlResult {
	url: string;
	/** True if logs were dropped from the URL because they wouldn't fit. */
	logsOmitted: boolean;
}

/**
 * Compose the pre-filled GitHub issue URL. The version / system /
 * settings fields go in full; the logs field gets whatever budget is
 * left after the rest of the URL is encoded. If that budget is below
 * MIN_LOG_BYTES, drop logs entirely and substitute a pointer to the
 * file-export flow.
 */
export function buildFeedbackUrl(d: Diagnostics): FeedbackUrlResult {
	const system = buildSystemBlock(d);
	const settings = buildSettingsSnapshot();
	const fullLogs = buildLogsBlock(d);

	const fixedParams = new URLSearchParams({
		template: TEMPLATE,
		version: d.app_version,
		system,
		settings
	});
	const fixedLen = `${ISSUE_URL_BASE}?${fixedParams.toString()}`.length;

	// Each extra byte of logs adds (roughly) 3 chars in URL-encoded form
	// for control chars and newlines, so we budget pessimistically.
	const remaining = URL_BUDGET - fixedLen - '&logs='.length;
	const rawBudget = Math.floor(remaining / 3);

	let logsField: string;
	let logsOmitted = false;
	if (rawBudget < MIN_LOG_BYTES) {
		logsField =
			'(Logs omitted — too large to fit in the URL. Click "Save Full Diagnostics" in Settings → Feedback and drag the file onto this issue.)';
		logsOmitted = true;
	} else {
		logsField = tailBytes(fullLogs, rawBudget);
	}

	const params = new URLSearchParams({
		template: TEMPLATE,
		version: d.app_version,
		system,
		settings,
		logs: logsField
	});
	return { url: `${ISSUE_URL_BASE}?${params.toString()}`, logsOmitted };
}

/**
 * Gather diagnostics, build the pre-filled GitHub issue URL, and open it
 * in the user's browser. Returns whether the logs section had to be
 * dropped so the UI can surface a hint to use the file-export flow.
 */
export async function openFeedbackIssue(): Promise<{ logsOmitted: boolean }> {
	const diag = await gatherDiagnostics();
	const { url, logsOmitted } = buildFeedbackUrl(diag);
	await invoke('open_url', { url });
	return { logsOmitted };
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
