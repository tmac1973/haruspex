/**
 * The Report issue button on a failure: a pre-filled GitHub issue for what
 * just went wrong, with the diagnostics saved for the user to attach.
 *
 * GitHub's new-issue link can't carry a file, so the issue's text holds the
 * error and the tail of the log nearest it, as much as fits in the URL. The
 * full diagnostics bundle (every log; see `feedback.ts`) is saved into
 * Downloads, which opens, for the user to drag onto the issue. Nothing is
 * sent from here: the user reads it and submits in their browser. All of it
 * is redacted first (secrets read this session, URL query strings, email
 * addresses).
 */

import { invoke } from '@tauri-apps/api/core';
import { buildFeedbackUrl, buildFullBundle, gatherDiagnostics } from '#lib/feedback.ts';

export interface IssueReport {
	/** Where it failed, as the user knows it: "Chat", "Code tab", "Job run". */
	where: string;
	/** The error as the user saw it. */
	error: string;
	/** The log lines nearest the failure, oldest first: a turn's debug log, a server's log. */
	log?: string[];
	/** What `log` is, for its heading in the issue. */
	logTitle?: string;
}

/** The issue text's budget, leaving the URL room for settings and stats. */
const BODY_CHARS = 3_500;
const TITLE_CHARS = 90;

function flat(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/** The newest lines of `log` that fit in `chars`, oldest first. */
export function logTail(log: string[], chars: number): string[] {
	const out: string[] = [];
	let used = 0;
	for (let i = log.length - 1; i >= 0; i--) {
		const line = log[i].length > 600 ? `${log[i].slice(0, 600)}…` : log[i];
		if (used + line.length + 1 > chars) break;
		out.unshift(line);
		used += line.length + 1;
	}
	return out;
}

/** The issue's "What happened?" text. */
export function issueText(r: IssueReport, bundleName: string): string {
	const error = r.error.length > 1_000 ? `${r.error.slice(0, 1_000)}…` : r.error;
	const head = [
		`${r.where} failed with:`,
		'```\n' + error + '\n```',
		`The full diagnostics are saved as ${bundleName}: please drag it onto this issue.`,
		'What were you doing when it happened?'
	].join('\n\n');
	if (!r.log?.length) return head;
	const room = BODY_CHARS - head.length - 80;
	const tail = room > 200 ? logTail(r.log, room) : [];
	if (!tail.length) return head;
	const cut = tail.length < r.log.length ? `, last ${tail.length} of ${r.log.length} lines` : '';
	return `${head}\n\n${r.logTitle ?? 'Log'}${cut}:\n\n\`\`\`\n${tail.join('\n')}\n\`\`\``;
}

export function issueTitle(r: IssueReport): string {
	const t = `[Bug] ${r.where}: ${flat(r.error)}`;
	return t.length > TITLE_CHARS ? `${t.slice(0, TITLE_CHARS - 1)}…` : t;
}

async function redact(lines: string[]): Promise<string[]> {
	return invoke<string[]>('feedback_redact', { lines });
}

/**
 * Save the diagnostics into Downloads, open that folder, and open the issue.
 * Resolves to where the bundle went.
 */
export async function reportIssue(r: IssueReport): Promise<string> {
	const [d, error, log] = await Promise.all([
		gatherDiagnostics(),
		redact(r.error.split('\n')).then((l) => l.join('\n')),
		r.log?.length ? redact(r.log) : Promise.resolve(undefined)
	]);
	const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
	const path = await invoke<string>('feedback_save_download', {
		stem: `haruspex-diagnostics-${stamp}`,
		extension: 'md',
		contents: buildFullBundle(d)
	});
	const folder = path.replace(/[\\/][^\\/]*$/, '');
	await invoke('folder_open', { path: folder });
	const report = { ...r, error, log };
	const url = buildFeedbackUrl(d, {
		title: issueTitle(report),
		whatHappened: issueText(report, path.slice(folder.length + 1))
	});
	await invoke('open_url', { url });
	return path;
}
