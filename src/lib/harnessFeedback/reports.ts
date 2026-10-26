/**
 * Reading back the model's reports on Haruspex's tools (Settings → Feedback →
 * Model feedback on tools): the list the viewer shows, the Markdown summary,
 * and sharing them as a GitHub issue with a zip attached.
 *
 * Sharing uploads nothing from here. The zip goes into the Downloads folder,
 * which opens, and a pre-filled issue opens in the browser; the user drags
 * the zip onto it. No save dialog: GTK's file chooser crashed the app while
 * loading thumbnails (a glycin fault). What leaves the machine is redacted
 * first (`agent_feedback_export` for the zip, `feedback_redact` for the issue
 * text): secrets read this session, URL query strings and email addresses.
 */

import { invoke } from '@tauri-apps/api/core';
import type { FeedbackEntry } from '#lib/harnessFeedback/report.ts';
import type { AgentFeedbackExport } from '#lib/ipc/gen/AgentFeedbackExport.ts';

/** A report as it is stored: the entry plus what Rust stamped on it. */
export interface StoredReport extends FeedbackEntry {
	recorded_at: string;
	app_version: string;
	os: string;
}

export function loadReports(): Promise<StoredReport[]> {
	return invoke<StoredReport[]>('agent_feedback_list');
}

export function clearReports(): Promise<void> {
	return invoke('agent_feedback_clear');
}

/** `[value, count]` pairs, most common first. */
export function countBy(
	reports: readonly StoredReport[],
	key: (r: StoredReport) => string
): Array<[string, number]> {
	const counts = new Map<string, number>();
	for (const r of reports) counts.set(key(r), (counts.get(key(r)) ?? 0) + 1);
	return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

/** `fetch_url` → `fetch_url`; the "none" a missing capability uses reads better spelt out. */
export function toolLabel(tool: string): string {
	return tool === 'none' || tool === 'unknown' ? 'no tool (missing capability)' : tool;
}

export function kindLabel(kind: string): string {
	return kind.replace(/_/g, ' ');
}

function countLines(pairs: Array<[string, number]>, label: (s: string) => string): string {
	return pairs.map(([k, n]) => `- ${label(k)}: ${n}`).join('\n');
}

function fence(text: string): string {
	return '```\n' + text.replace(/```/g, "'''") + '\n```';
}

/** The reports as a Markdown document, for `summary.md` in the zip. */
export function reportsMarkdown(reports: readonly StoredReport[]): string {
	const parts = [
		'# Haruspex model feedback',
		`${reports.length} report${reports.length === 1 ? '' : 's'}, newest first.`,
		`## By tool\n${countLines(
			countBy(reports, (r) => r.tool),
			toolLabel
		)}`,
		`## By kind\n${countLines(
			countBy(reports, (r) => r.kind),
			kindLabel
		)}`,
		`## By model\n${countLines(
			countBy(reports, (r) => r.model),
			(m) => m
		)}`
	];
	for (const r of reports) {
		const lines = [
			`## ${toolLabel(r.tool)}: ${kindLabel(r.kind)}`,
			`${r.recorded_at} · ${r.origin === 'reflection' ? 'job review' : r.mode} · ${r.model} · v${r.app_version}`,
			`**What happened:** ${r.what_happened}`,
			`**Expected:** ${r.expected}`
		];
		if (r.suggestion) lines.push(`**Suggestion:** ${r.suggestion}`);
		for (const c of r.trace ?? []) {
			lines.push(
				`### ${c.tool}${c.error ? ' (failed)' : ''}\nArguments:\n${fence(c.args)}\nResult:\n${fence(c.result)}`
			);
		}
		parts.push(lines.join('\n\n'));
	}
	return parts.join('\n\n') + '\n';
}

const REPO = 'tmac1973/haruspex';
/** Below GitHub's URL limit with room for the template's other fields. */
const ISSUE_BODY_CHARS = 5_000;
const LINE_CHARS = 220;

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The issue's "What happened?" text: counts, then one line per report. */
export function issueSummary(reports: readonly StoredReport[], zipName: string): string {
	const head = [
		`The model filed ${reports.length} report${reports.length === 1 ? '' : 's'} on Haruspex's tools (Settings → Feedback → Model feedback on tools).`,
		`Attach ${zipName} below: it has every report with the tool calls behind it.`,
		`By tool:\n${countLines(
			countBy(reports, (r) => r.tool),
			toolLabel
		)}`,
		'Reports:'
	].join('\n\n');
	let body = head;
	for (const [i, r] of reports.entries()) {
		const line = `\n- **${toolLabel(r.tool)}** (${kindLabel(r.kind)}): ${clip(r.what_happened, LINE_CHARS)}`;
		if (body.length + line.length > ISSUE_BODY_CHARS) {
			body += `\n- …and ${reports.length - i} more in the zip.`;
			break;
		}
		body += line;
	}
	return body;
}

export function issueUrl(reports: readonly StoredReport[], body: string, os: string): string {
	const models = countBy(reports, (r) => r.model).map(([m]) => m);
	const params = new URLSearchParams({
		template: 'feedback.yml',
		title: `[Model feedback] ${reports.length} report${reports.length === 1 ? '' : 's'}${models.length === 1 ? ` from ${models[0]}` : ''}`,
		'what-happened': body,
		version: reports[0]?.app_version ?? '',
		system: `OS: ${os}`
	});
	return `https://github.com/${REPO}/issues/new?${params.toString()}`;
}

async function redact(text: string): Promise<string> {
	const lines = await invoke<string[]>('feedback_redact', { lines: text.split('\n') });
	return lines.join('\n');
}

export interface ShareResult {
	path: string;
	count: number;
}

/**
 * Save the redacted zip of `reports` into Downloads, open that folder, and
 * open a pre-filled issue for it in the browser. The user attaches the zip
 * and submits there.
 */
export async function shareReports(reports: readonly StoredReport[]): Promise<ShareResult> {
	const saved = await invoke<AgentFeedbackExport>('agent_feedback_export', {
		summary: reportsMarkdown(reports),
		reports
	});
	const folder = saved.path.replace(/[\\/][^\\/]*$/, '');
	const zipName = saved.path.slice(folder.length + 1);
	await invoke('open_folder', { path: folder });
	const body = await redact(issueSummary(reports, zipName));
	await invoke('open_url', { url: issueUrl(reports, body, reports[0]?.os ?? '') });
	return saved;
}
