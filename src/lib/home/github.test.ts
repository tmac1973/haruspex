import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { McpServerConfig } from '#lib/ipc/gen/McpServerConfig.ts';
import {
	GET_ME,
	GITHUB_FIXTURE_VERSION,
	ISSUE_COMMENTS,
	ISSUE_GET,
	LIST_ISSUES,
	SEARCH_PULL_REQUESTS,
	SEARCH_REPOSITORIES,
	reply,
	toolError
} from './github.fixtures';

const m = vi.hoisted(() => ({
	servers: [] as Partial<McpServerConfig>[],
	status: 'Ready',
	calls: [] as { name: string; arguments: Record<string, unknown> }[],
	answer: (() => null) as (name: string, args: Record<string, unknown>) => unknown
}));
vi.mock('@tauri-apps/api/core', () => ({
	invoke: async (_cmd: string, a: { name: string; arguments: Record<string, unknown> }) => {
		m.calls.push({ name: a.name, arguments: a.arguments });
		return m.answer(a.name, a.arguments);
	}
}));
vi.mock('#lib/stores/settings.ts', async (importOriginal) =>
	(await import('#lib/testing/settings.ts')).mockSettingsModule(importOriginal, {
		settings: () => ({ integrations: { mcp: { servers: m.servers } } })
	})
);
vi.mock('#lib/stores/mcpServers.svelte.ts', () => ({
	mcpState: () => ({ status: { type: m.status } })
}));

import {
	DEFAULT_GITHUB_CONFIG,
	_resetForTests,
	fetchGitHub,
	issuesFrom,
	parseOutcome,
	prQuery,
	pullsFrom,
	readIssueBody,
	type GitHubConfig,
	type GitHubResult
} from './github';

const NOW = Date.parse('2026-11-02T12:00:00Z');
const github = { id: 'gh', enabled: true, source: { kind: 'catalog', entryId: 'github' } };

/** A desktop whose GitHub server answers from the fixtures. */
function answers(over: Record<string, unknown> = {}) {
	return (name: string, args: Record<string, unknown>) => {
		if (name in over) return over[name];
		switch (name) {
			case 'get_me':
				return reply(GET_ME);
			case 'search_repositories':
				return reply(SEARCH_REPOSITORIES);
			case 'list_issues':
				return reply(args.repo === 'app' ? LIST_ISSUES : { issues: [], totalCount: 0 });
			case 'issue_read':
				return reply(args.method === 'get' ? ISSUE_GET : ISSUE_COMMENTS);
			case 'search_pull_requests':
				return reply(SEARCH_PULL_REQUESTS);
		}
		throw new Error(`unexpected ${name}`);
	};
}

const config = (over: Partial<GitHubConfig> = {}) => ({ ...DEFAULT_GITHUB_CONFIG, ...over });

beforeEach(() => {
	_resetForTests();
	m.servers = [github as Partial<McpServerConfig>];
	m.status = 'Ready';
	m.calls = [];
	m.answer = answers();
});

describe('the fixtures', () => {
	it("match the catalog's GitHub server version", () => {
		const catalog = JSON.parse(
			readFileSync(resolve(__dirname, '../../../src-tauri/resources/mcp-catalog.json'), 'utf8')
		) as { entries: { id: string; acquisition: { version: string } }[] };
		const entry = catalog.entries.find((e) => e.id === 'github')!;
		expect(entry.acquisition.version).toBe(GITHUB_FIXTURE_VERSION);
	});
});

describe('parsing', () => {
	it("reads list_issues' GraphQL issues, building the URL and a stable id", () => {
		const [first, second] = issuesFrom(LIST_ISSUES, 'octocat/app');
		expect(first).toEqual({
			id: 'octocat/app#42',
			repo: 'octocat/app',
			number: 42,
			title: 'Crash on start',
			url: 'https://github.com/octocat/app/issues/42',
			author: 'alice',
			labels: ['bug'],
			comments: 2,
			updatedAt: '2026-10-31T08:00:00Z',
			isPr: false
		});
		// Left out at zero, as the server does.
		expect(second).toMatchObject({ comments: 0, labels: [] });
	});

	it('reads the REST pull request search', () => {
		expect(pullsFrom(SEARCH_PULL_REQUESTS)).toEqual([
			{
				id: 'PR_kwDOabc',
				repo: 'octocat/app',
				number: 7,
				title: 'Add a flag',
				url: 'https://github.com/octocat/app/pull/7',
				author: 'dave',
				labels: ['needs review'],
				comments: 0,
				updatedAt: '2026-10-31T09:00:00Z',
				isPr: true
			}
		]);
	});

	it('treats a tool error and a question as failures', () => {
		expect(() => parseOutcome(toolError('failed to get user: 401 Bad credentials'))).toThrow(
			'401 Bad credentials'
		);
		expect(() => parseOutcome({ type: 'inputRequired', requests: [], requestState: null })).toThrow(
			'GitHub asked for input'
		);
		expect(parseOutcome(reply(ISSUE_COMMENTS))).toEqual(ISSUE_COMMENTS);
	});
});

describe('the server', () => {
	it('says what to do when it is missing, off or stopped, and calls nothing', async () => {
		m.servers = [];
		expect(await fetchGitHub(config(), NOW)).toEqual({
			skip: 'Add GitHub in Settings → MCP servers.'
		});
		m.servers = [{ ...github, enabled: false } as Partial<McpServerConfig>];
		expect(await fetchGitHub(config(), NOW)).toEqual({
			skip: 'Turn on GitHub in Settings → MCP servers.'
		});
		m.servers = [github as Partial<McpServerConfig>];
		m.status = 'Stopped';
		expect(await fetchGitHub(config(), NOW)).toEqual({
			skip: 'Start GitHub in Settings → MCP servers.'
		});
		expect(m.calls).toEqual([]);
	});

	it('fails the fetch on a tool error', async () => {
		m.answer = answers({ get_me: toolError('failed to get user: 401 Bad credentials') });
		await expect(fetchGitHub(config(), NOW)).rejects.toThrow('401 Bad credentials');
	});
});

describe('issues from others', () => {
	it("keeps others' unanswered issues, skipping own, bots, hidden labels and archived repos", async () => {
		const out = (await fetchGitHub(config({ labelsExclude: ['WontFix'] }), NOW)) as GitHubResult;
		expect(out.items.map((i) => i.number)).toEqual([42, 38]);

		const repos = m.calls.filter((c) => c.name === 'list_issues').map((c) => c.arguments.repo);
		expect(repos).toEqual(['app', 'lib']);
		expect(m.calls.find((c) => c.name === 'list_issues')!.arguments).toMatchObject({
			owner: 'octocat',
			state: 'OPEN',
			since: '2026-10-03T12:00:00.000Z',
			orderBy: 'UPDATED_AT',
			direction: 'DESC'
		});
		// #38 has no comments, so only #42's are read.
		const reads = m.calls.filter((c) => c.name === 'issue_read');
		expect(reads.map((c) => c.arguments.issue_number)).toEqual([42]);
	});

	it('drops an issue you have commented on, and stops reading comments at max', async () => {
		m.answer = answers({
			issue_read: reply([...ISSUE_COMMENTS, { id: 2, user: { login: 'OCTOCAT' } }])
		});
		const out = (await fetchGitHub(config(), NOW)) as GitHubResult;
		expect(out.items.map((i) => i.number)).toEqual([39, 38]);

		_resetForTests();
		m.calls = [];
		m.answer = answers();
		const one = (await fetchGitHub(config({ max: 1 }), NOW)) as GitHubResult;
		expect(one.items.map((i) => i.number)).toEqual([42]);
		expect(m.calls.filter((c) => c.name === 'issue_read')).toHaveLength(1);
	});

	it('reads no comments without Unanswered only, and keeps the repos for an hour', async () => {
		await fetchGitHub(config({ unanswered: false, excludeBots: false }), NOW);
		expect(m.calls.some((c) => c.name === 'issue_read')).toBe(false);
		await fetchGitHub(config({ unanswered: false }), NOW + 30 * 60_000);
		expect(m.calls.filter((c) => c.name === 'search_repositories')).toHaveLength(1);
		await fetchGitHub(config({ unanswered: false }), NOW + 61 * 60_000);
		expect(m.calls.filter((c) => c.name === 'search_repositories')).toHaveLength(2);
	});

	it('reads listed repos as given, and an owner’s newest after them', async () => {
		await fetchGitHub(config({ repos: ['other/thing'], owners: ['octocat'] }), NOW);
		expect(m.calls.find((c) => c.name === 'search_repositories')!.arguments).toMatchObject({
			query: 'user:octocat archived:false',
			sort: 'updated'
		});
		const repos = m.calls
			.filter((c) => c.name === 'list_issues')
			.map((c) => `${c.arguments.owner}/${c.arguments.repo}`);
		expect(repos).toEqual(['other/thing', 'octocat/app', 'octocat/lib']);
	});
});

describe('pull requests', () => {
	it('builds the review query for your repos', () => {
		expect(prQuery(config({ preset: 'prs_to_review' }), 'octocat', NOW)).toBe(
			'is:open user:octocat updated:>=2026-10-03 review-requested:octocat'
		);
	});

	it('builds the from-others query with scope, labels and filters', () => {
		const q = prQuery(
			config({
				preset: 'prs_from_others',
				repos: ['a/b'],
				owners: ['org'],
				labelsInclude: ['needs review'],
				labelsExclude: ['wip'],
				days: 7
			}),
			'octocat',
			NOW
		);
		expect(q).toBe(
			'is:open repo:a/b user:org label:"needs review" -label:wip updated:>=2026-10-26 ' +
				'-author:octocat -author:app/dependabot -author:app/renovate -commenter:octocat'
		);
		expect(
			prQuery(
				config({ preset: 'prs_from_others', excludeBots: false, unanswered: false }),
				'me',
				NOW
			)
		).toBe('is:open user:me updated:>=2026-10-03 -author:me');
	});

	it('fetches with one search', async () => {
		const out = (await fetchGitHub(
			config({ preset: 'prs_to_review', max: 5 }),
			NOW
		)) as GitHubResult;
		expect(out.items.map((i) => i.id)).toEqual(['PR_kwDOabc']);
		expect(m.calls.map((c) => c.name)).toEqual(['get_me', 'search_pull_requests']);
		expect(m.calls[1].arguments).toMatchObject({ sort: 'updated', order: 'desc', perPage: 5 });
	});
});

describe('readIssueBody', () => {
	it('reads the body with issue_read get', async () => {
		expect(await readIssueBody('octocat/app', 42)).toBe('It crashes when the config is empty.');
		expect(m.calls[0]).toEqual({
			name: 'issue_read',
			arguments: { method: 'get', owner: 'octocat', repo: 'app', issue_number: 42 }
		});
	});
});
