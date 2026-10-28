/**
 * The log nearest each kind of failure, for a Report issue button (see
 * `ReportIssueButton.svelte`). The full diagnostics bundle carries every log;
 * these pick the one worth putting in the issue's text.
 */

import { invoke } from '@tauri-apps/api/core';
import { getDebugLogs } from '#lib/debugLog.ts';

/** Where a report button finds its log: read when pressed, not when shown. */
export type LogSource = () => string[] | Promise<string[]>;

/**
 * The debug log's lines in `category` (`code`, `shell`, `jobs`, …), newest
 * last. Only Chat tags its lines with a turn, so elsewhere this is the
 * category's recent history, which ends at the failure.
 */
export function debugLog(...categories: string[]): LogSource {
	const tags = categories.map((c) => `] [${c}] `);
	return () => getDebugLogs().filter((l) => tags.some((t) => l.includes(t)));
}

/** llama-server's log, then its crash log when there is one. */
export const serverLog: LogSource = async () => {
	const [log, crashes] = await Promise.all([
		invoke<string[]>('get_server_logs').catch(() => [] as string[]),
		invoke<string>('get_llama_crash_log').catch(() => '')
	]);
	return crashes.trim() ? [...log, '--- crash log ---', ...crashes.trim().split('\n')] : log;
};

export const imageEngineLog: LogSource = () =>
	invoke<string[]>('image_engine_logs').catch(() => [] as string[]);

export const appLog: LogSource = () => invoke<string[]>('get_app_logs').catch(() => [] as string[]);

export function mcpLog(id: string): LogSource {
	return () => invoke<string[]>('mcp_server_logs', { id }).catch(() => [] as string[]);
}

/**
 * Messages in an error slot that aren't a failure to report: the user
 * stopping something (Chat, the Code tab, the Shell), or a state they can
 * see and fix.
 */
const NOT_FAILURES = new Set([
	'Cancelled before the model started.',
	'Stopped.',
	'Cancelled.',
	'Shell session not ready yet.'
]);

export function worthReporting(message: string | null | undefined): boolean {
	return !!message && !NOT_FAILURES.has(message.trim());
}

/** A job run's Report issue: the recent job, agent and API lines. */
export function jobReport(error: string) {
	return {
		where: 'Job run',
		error,
		log: debugLog('jobs', 'agent', 'api'),
		logTitle: 'Recent debug log (jobs, agent and API lines)'
	};
}
