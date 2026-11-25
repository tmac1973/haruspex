/**
 * Filing a notebook or a card on GitHub: a new issue, or a comment on one.
 * Calls the catalog's GitHub MCP server directly, as Home's GitHub card does
 * (`home/github.ts`), with no model: the user's click on Create is the
 * consent, so the server's tool switches (which govern the model) don't
 * apply. Tool names and arguments are github-mcp-server v1.12.0's.
 */
import { callGitHubTool, serverNotice } from '#lib/home/github.ts';
import { persistItem } from '#lib/persist.ts';

/** GitHub refuses an issue or comment body longer than this. */
export const MAX_BODY_CHARS = 65_536;

/** Whether GitHub can be written to now: the server is set up and running. */
export function githubReady(): boolean {
	return serverNotice() === null;
}

export interface RepoRef {
	owner: string;
	repo: string;
}

/** `owner/name`, or a github.com URL inside the repository; null otherwise. */
export function parseRepo(text: string): RepoRef | null {
	const t = text.trim();
	const url = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/i.exec(t);
	const m = url ?? /^([\w.-]+)\/([\w.-]+)$/.exec(t);
	return m ? { owner: m[1], repo: m[2].replace(/\.git$/, '') } : null;
}

/**
 * An issue number: `123`, `#123`, or an issue or pull request URL (which
 * names its repository too).
 */
export function parseIssue(text: string): { number: number; repo?: RepoRef } | null {
	const t = text.trim();
	const url = /^https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)\/(?:issues|pull)\/(\d+)/i.exec(t);
	if (url) return { number: Number(url[3]), repo: { owner: url[1], repo: url[2] } };
	const n = /^#?(\d+)$/.exec(t);
	return n ? { number: Number(n[1]) } : null;
}

const RECENT_KEY = 'haruspex.githubIssueRepos';

/** Repositories filed to before, most recent first. */
export function recentRepos(): string[] {
	try {
		const raw = JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]');
		return Array.isArray(raw) ? raw.filter((r): r is string => typeof r === 'string') : [];
	} catch {
		return [];
	}
}

function remember(repo: RepoRef) {
	const name = `${repo.owner}/${repo.repo}`;
	const list = [name, ...recentRepos().filter((r) => r.toLowerCase() !== name.toLowerCase())];
	try {
		persistItem(RECENT_KEY, JSON.stringify(list.slice(0, 10)));
	} catch {
		// A convenience only.
	}
}

let mine: Promise<string[]> | null = null;

/** The token owner's repositories, newest first (asked once per session). */
export function myRepos(): Promise<string[]> {
	mine ??= (async () => {
		const { login } = JSON.parse(await callGitHubTool('get_me', {})) as { login: string };
		const found = JSON.parse(
			await callGitHubTool('search_repositories', {
				query: `user:${login} archived:false`,
				sort: 'updated',
				order: 'desc',
				perPage: 30
			})
		) as { items?: { full_name: string }[] };
		return (found.items ?? []).map((r) => r.full_name);
	})().catch((e: unknown) => {
		mine = null;
		throw e;
	});
	return mine;
}

/** Names from a reply that is a list of labels, or holds one under `labels`. */
export function labelNames(reply: unknown): string[] {
	const list = Array.isArray(reply)
		? reply
		: ((reply as { labels?: unknown[] } | null)?.labels ?? []);
	return list
		.map((l) => (typeof l === 'string' ? l : (l as { name?: unknown })?.name))
		.filter((n): n is string => typeof n === 'string' && n !== '');
}

/** A repository's labels. */
export async function repoLabels(repo: RepoRef): Promise<string[]> {
	return labelNames(JSON.parse(await callGitHubTool('list_label', { ...repo })));
}

/** An issue's title, to show which one a comment goes on. */
export async function issueTitle(repo: RepoRef, number: number): Promise<string> {
	const issue = JSON.parse(
		await callGitHubTool('issue_read', { method: 'get', ...repo, issue_number: number })
	) as { title?: string };
	return issue.title ?? '';
}

/** The github.com link in a write's reply, whatever else the reply holds. */
export function linkIn(reply: string, repo: RepoRef, fallback?: number): string {
	const html = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/(?:issues|pull)\/\d+(?:#[\w-]+)?/.exec(
		reply
	);
	if (html) return html[0];
	const n = /"number"\s*:\s*(\d+)/.exec(reply)?.[1] ?? fallback;
	return n
		? `https://github.com/${repo.owner}/${repo.repo}/issues/${n}`
		: `https://github.com/${repo.owner}/${repo.repo}/issues`;
}

function checkBody(body: string) {
	if (body.length > MAX_BODY_CHARS) {
		throw new Error(`GitHub takes at most ${MAX_BODY_CHARS.toLocaleString()} characters.`);
	}
}

/** Open an issue; resolves to its link. */
export async function createIssue(
	repo: RepoRef,
	title: string,
	body: string,
	labels: string[]
): Promise<string> {
	checkBody(body);
	const reply = await callGitHubTool('issue_write', {
		method: 'create',
		...repo,
		title: title.trim(),
		body,
		...(labels.length ? { labels } : {})
	});
	remember(repo);
	return linkIn(reply, repo);
}

/** Comment on an issue or pull request; resolves to the comment's link. */
export async function commentOn(repo: RepoRef, number: number, body: string): Promise<string> {
	checkBody(body);
	const reply = await callGitHubTool('add_issue_comment', {
		...repo,
		issue_number: number,
		body
	});
	remember(repo);
	return linkIn(reply, repo, number);
}

export function _resetForTests(): void {
	mine = null;
}
