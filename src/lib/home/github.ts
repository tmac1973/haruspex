/**
 * Home's GitHub card: issues and pull requests that need you, read from the
 * catalog's GitHub MCP server (`github-mcp-server`) by calling its tools
 * directly, with no model. The card needs no GitHub settings of its own; the
 * server's token decides what it can see.
 *
 * Issues come from `list_issues` per repo, filtered here: the server's
 * `search_issues` is semantic on github.com and doesn't honour negated
 * qualifiers. Pull requests come from one lexical `search_pull_requests`.
 * Reply shapes are those of v1.12.0 (`github.fixtures.ts`).
 */
import { invoke } from '@tauri-apps/api/core';
import type { McpCallOutcome } from '#lib/ipc/gen/McpCallOutcome.ts';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { mcpState } from '#lib/stores/mcpServers.svelte.ts';
import type { FetchSkip } from '#lib/home/fetchedCards.svelte.ts';

export type GitHubPreset = 'issues_from_others' | 'prs_to_review' | 'prs_from_others';

/** Each preset's card title. */
export const GITHUB_PRESETS: Record<GitHubPreset, string> = {
	issues_from_others: 'Issues from others',
	prs_to_review: 'Reviews requested',
	prs_from_others: 'Pull requests from others'
};

export const GITHUB_EMPTY: Record<GitHubPreset, string> = {
	issues_from_others: 'No open issues from others.',
	prs_to_review: 'No reviews requested.',
	prs_from_others: 'No open pull requests from others.'
};

export interface GitHubConfig {
	preset: GitHubPreset;
	/** Users or organisations; with `repos` empty too, the token owner's repos. */
	owners: string[];
	/** `owner/name`. */
	repos: string[];
	/** Only ones you haven't commented on. */
	unanswered: boolean;
	excludeBots: boolean;
	labelsInclude: string[];
	labelsExclude: string[];
	/** Updated within this many days. */
	days: number;
	max: number;
}

export const DEFAULT_GITHUB_CONFIG: GitHubConfig = {
	preset: 'issues_from_others',
	owners: [],
	repos: [],
	unanswered: true,
	excludeBots: true,
	labelsInclude: [],
	labelsExclude: [],
	days: 30,
	max: 15
};

export interface GitHubItem {
	/** Stable across fetches: a pull request's node id, an issue's `owner/name#N`. */
	id: string;
	/** `owner/name`. */
	repo: string;
	number: number;
	title: string;
	url: string;
	author: string;
	labels: string[];
	comments: number;
	/** ISO 8601. */
	updatedAt: string;
	isPr: boolean;
}

export interface GitHubResult {
	items: GitHubItem[];
}

export function githubConfigOf(json: string): GitHubConfig {
	try {
		return { ...DEFAULT_GITHUB_CONFIG, ...(JSON.parse(json) as Partial<GitHubConfig>) };
	} catch {
		return { ...DEFAULT_GITHUB_CONFIG };
	}
}

/** The line under the card's title that tells two cards of one preset apart. */
export function scopeLine(config: GitHubConfig): string {
	const scope = [...config.owners, ...config.repos];
	return scope.length ? scope.join(', ') : 'My repos';
}

/** A comma-separated field as its entries. */
export function splitList(text: string): string[] {
	return text
		.split(',')
		.map((s) => s.trim())
		.filter(Boolean);
}

/** The first entry that isn't a GitHub user or organisation name, or null. */
export function badOwner(owners: string[]): string | null {
	return owners.find((o) => !/^[\w.-]+$/.test(o)) ?? null;
}

/** The first entry that isn't `owner/name`, or null. */
export function badRepo(repos: string[]): string | null {
	return repos.find((r) => !/^[\w.-]+\/[\w.-]+$/.test(r)) ?? null;
}

// ── The server ──────────────────────────────────────────────────────────

/** The first configured MCP server from the catalog's GitHub entry, enabled or not. */
export function githubServer(): McpServerConfig | null {
	return (
		getSettings().integrations.mcp.servers.find(
			(s) => s.source.kind === 'catalog' && s.source.entryId === 'github'
		) ?? null
	);
}

/** Why the card can't read GitHub now, or null when the server is running. */
export function serverNotice(): string | null {
	const server = githubServer();
	if (!server) return 'Add GitHub in Settings → MCP servers.';
	if (!server.enabled) return 'Turn on GitHub in Settings → MCP servers.';
	if (mcpState(server.id).status.type !== 'Ready') return 'Start GitHub in Settings → MCP servers.';
	return null;
}

/** One tool call, its text parsed as JSON. Throws on a tool error or a question. */
async function callTool<T>(name: string, args: Record<string, unknown>): Promise<T> {
	const server = githubServer();
	if (!server) throw new Error('No GitHub server is set up.');
	const outcome = await invoke<McpCallOutcome>('mcp_call_tool', {
		id: server.id,
		name,
		arguments: args,
		inputResponses: null,
		requestState: null
	});
	return parseOutcome<T>(outcome);
}

/** A tool reply's JSON. Exported for the tests. */
export function parseOutcome<T>(outcome: McpCallOutcome): T {
	if (outcome.type !== 'complete') {
		throw new Error('GitHub asked for input; open it from a chat instead.');
	}
	const text = Array.isArray(outcome.content)
		? (outcome.content as { type?: string; text?: string }[])
				.filter((c) => c.type === 'text' && typeof c.text === 'string')
				.map((c) => c.text)
				.join('')
		: '';
	if (outcome.isError) throw new Error(text || 'GitHub returned an error.');
	return JSON.parse(text) as T;
}

// ── Replies (v1.12.0) ───────────────────────────────────────────────────

interface MeReply {
	login: string;
}

interface RepoSearchReply {
	items?: { full_name: string; archived?: boolean }[];
}

/** `list_issues`: GraphQL, so no URL or node id, and `comments` is left out at 0. */
interface ListIssuesReply {
	issues?: {
		number: number;
		title: string;
		user?: { login?: string };
		labels?: string[];
		comments?: number;
		updated_at?: string;
	}[];
}

/** `issue_read` `get_comments`: a bare array. */
type CommentsReply = { user?: { login?: string } }[];

/** `search_pull_requests`: the REST search response as GitHub sends it. */
interface PrSearchReply {
	items?: {
		node_id?: string;
		number: number;
		title: string;
		html_url: string;
		repository_url?: string;
		user?: { login?: string; type?: string };
		labels?: { name?: string }[];
		comments?: number;
		updated_at?: string;
	}[];
}

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** `owner/name` from an API repository URL. */
function repoOfUrl(url: string | undefined): string {
	const m = /\/repos\/([^/]+\/[^/]+)$/.exec(url ?? '');
	return m ? m[1] : '';
}

export function issuesFrom(reply: ListIssuesReply, repo: string): GitHubItem[] {
	return (reply.issues ?? []).map((i) => ({
		id: `${repo}#${i.number}`,
		repo,
		number: i.number,
		title: i.title,
		url: `https://github.com/${repo}/issues/${i.number}`,
		author: i.user?.login ?? '',
		labels: i.labels ?? [],
		comments: i.comments ?? 0,
		updatedAt: i.updated_at ?? '',
		isPr: false
	}));
}

export function pullsFrom(reply: PrSearchReply): GitHubItem[] {
	return (reply.items ?? []).map((p) => {
		const repo = repoOfUrl(p.repository_url);
		return {
			id: p.node_id ?? p.html_url,
			repo,
			number: p.number,
			title: p.title,
			url: p.html_url,
			author: p.user?.login ?? '',
			labels: (p.labels ?? []).map((l) => l.name ?? '').filter(Boolean),
			comments: p.comments ?? 0,
			updatedAt: p.updated_at ?? '',
			isPr: true
		};
	});
}

// ── Fetching ────────────────────────────────────────────────────────────

const REPO_LIMIT = 30;
const REPO_CACHE_MS = 60 * 60_000;
// Bookkeeping, never rendered.
const repoCache = new Map<string, { at: number; repos: string[] }>();

/** The repos an issues card reads: `repos` as given, then the owners' newest, up to 30. */
async function resolveRepos(config: GitHubConfig, login: string, now: number): Promise<string[]> {
	const owners = config.owners.length || config.repos.length ? config.owners : [login];
	const key = JSON.stringify([owners, config.repos]);
	const cached = repoCache.get(key);
	if (cached && now - cached.at < REPO_CACHE_MS) return cached.repos;
	const repos = [...config.repos];
	for (const owner of owners) {
		if (repos.length >= REPO_LIMIT) break;
		const found = await callTool<RepoSearchReply>('search_repositories', {
			query: `user:${owner} archived:false`,
			sort: 'updated',
			order: 'desc',
			perPage: REPO_LIMIT
		});
		for (const r of found.items ?? []) {
			if (r.archived || repos.some((x) => same(x, r.full_name))) continue;
			if (repos.length >= REPO_LIMIT) break;
			repos.push(r.full_name);
		}
	}
	repoCache.set(key, { at: now, repos });
	return repos;
}

function isBot(login: string): boolean {
	return login.toLowerCase().endsWith('[bot]');
}

async function fetchIssues(
	config: GitHubConfig,
	login: string,
	now: number
): Promise<GitHubItem[]> {
	const since = new Date(now - config.days * 86_400_000).toISOString();
	const all: GitHubItem[] = [];
	for (const repo of await resolveRepos(config, login, now)) {
		const [owner, name] = repo.split('/');
		const reply = await callTool<ListIssuesReply>('list_issues', {
			owner,
			repo: name,
			state: 'OPEN',
			since,
			...(config.labelsInclude.length ? { labels: config.labelsInclude } : {}),
			orderBy: 'UPDATED_AT',
			direction: 'DESC',
			perPage: 50
		});
		all.push(...issuesFrom(reply, repo));
	}
	const exclude = config.labelsExclude.map((l) => l.toLowerCase());
	const kept = all
		.filter((i) => !same(i.author, login))
		.filter((i) => !config.excludeBots || !isBot(i.author))
		.filter((i) => !i.labels.some((l) => exclude.includes(l.toLowerCase())))
		.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
	if (!config.unanswered) return kept.slice(0, config.max);
	const out: GitHubItem[] = [];
	for (const issue of kept) {
		if (out.length >= config.max) break;
		if (issue.comments > 0 && (await commentedOn(issue, login))) continue;
		out.push(issue);
	}
	return out;
}

async function commentedOn(issue: GitHubItem, login: string): Promise<boolean> {
	const [owner, repo] = issue.repo.split('/');
	const comments = await callTool<CommentsReply>('issue_read', {
		method: 'get_comments',
		owner,
		repo,
		issue_number: issue.number,
		perPage: 100
	});
	return comments.some((c) => same(c.user?.login ?? '', login));
}

/** The `search_pull_requests` query for a pull request preset. */
export function prQuery(config: GitHubConfig, login: string, now: number): string {
	const scope = [...config.repos.map((r) => `repo:${r}`), ...config.owners.map((o) => `user:${o}`)];
	if (scope.length === 0) scope.push(`user:${login}`);
	const label = (l: string) => (/\s/.test(l) ? `"${l}"` : l);
	const since = new Date(now - config.days * 86_400_000).toISOString().slice(0, 10);
	const parts = [
		'is:open',
		...scope,
		...config.labelsInclude.map((l) => `label:${label(l)}`),
		...config.labelsExclude.map((l) => `-label:${label(l)}`),
		`updated:>=${since}`
	];
	if (config.preset === 'prs_to_review') {
		parts.push(`review-requested:${login}`);
	} else {
		parts.push(`-author:${login}`);
		if (config.excludeBots) parts.push('-author:app/dependabot', '-author:app/renovate');
		if (config.unanswered) parts.push(`-commenter:${login}`);
	}
	return parts.join(' ');
}

async function fetchPulls(config: GitHubConfig, login: string, now: number): Promise<GitHubItem[]> {
	const reply = await callTool<PrSearchReply>('search_pull_requests', {
		query: prQuery(config, login, now),
		sort: 'updated',
		order: 'desc',
		perPage: config.max
	});
	return pullsFrom(reply).slice(0, config.max);
}

/** The card type's `fetch`: a result, or a notice when the server isn't running. */
export async function fetchGitHub(
	raw: Record<string, unknown>,
	now = Date.now()
): Promise<GitHubResult | FetchSkip> {
	const notice = serverNotice();
	if (notice) return { skip: notice };
	const config = { ...DEFAULT_GITHUB_CONFIG, ...(raw as Partial<GitHubConfig>) };
	const { login } = await callTool<MeReply>('get_me', {});
	const items =
		config.preset === 'issues_from_others'
			? await fetchIssues(config, login, now)
			: await fetchPulls(config, login, now);
	return { items };
}

/** An issue's body, for Work on this. */
export async function readIssueBody(repo: string, number: number): Promise<string> {
	const [owner, name] = repo.split('/');
	const issue = await callTool<{ body?: string }>('issue_read', {
		method: 'get',
		owner,
		repo: name,
		issue_number: number
	});
	return issue.body ?? '';
}

export function _resetForTests(): void {
	repoCache.clear();
}
