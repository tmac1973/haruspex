/**
 * Replies of the GitHub MCP server's tools, in the shapes its source at
 * `GITHUB_FIXTURE_VERSION` writes them: each is one text content holding
 * compact JSON, with no structured content. Written from that source (the
 * Minimal* types and go-github's search result), not recorded, so they hold
 * no one's real data. A test fails when the catalog moves to another
 * version: check the shapes again and update them with it.
 */
import type { McpCallOutcome } from '#lib/ipc/gen/McpCallOutcome.ts';

export const GITHUB_FIXTURE_VERSION = 'v1.12.0';

export function reply(value: unknown): McpCallOutcome {
	return {
		type: 'complete',
		content: [{ type: 'text', text: JSON.stringify(value) }],
		structuredContent: null,
		isError: false
	};
}

export function toolError(text: string): McpCallOutcome {
	return {
		type: 'complete',
		content: [{ type: 'text', text }],
		structuredContent: null,
		isError: true
	};
}

/** `get_me`: a MinimalUser with details. */
export const GET_ME = {
	login: 'octocat',
	id: 583231,
	profile_url: 'https://github.com/octocat',
	avatar_url: 'https://avatars.githubusercontent.com/u/583231?v=4',
	details: {
		name: 'The Octocat',
		public_repos: 8,
		public_gists: 8,
		followers: 1,
		following: 9,
		created_at: '2011-01-25T18:44:36Z',
		updated_at: '2026-01-01T00:00:00Z'
	}
};

/** `search_repositories` with minimal output: no owner object, `full_name` instead. */
export const SEARCH_REPOSITORIES = {
	total_count: 3,
	incomplete_results: false,
	items: [
		{
			id: 1,
			name: 'app',
			full_name: 'octocat/app',
			html_url: 'https://github.com/octocat/app',
			stargazers_count: 10,
			forks_count: 2,
			open_issues_count: 3,
			updated_at: '2026-10-30T12:00:00Z',
			private: false,
			fork: false,
			archived: false,
			default_branch: 'main'
		},
		{
			id: 2,
			name: 'old',
			full_name: 'octocat/old',
			html_url: 'https://github.com/octocat/old',
			stargazers_count: 0,
			forks_count: 0,
			open_issues_count: 0,
			private: false,
			fork: false,
			archived: true
		},
		{
			id: 3,
			name: 'lib',
			full_name: 'octocat/lib',
			html_url: 'https://github.com/octocat/lib',
			stargazers_count: 1,
			forks_count: 0,
			open_issues_count: 1,
			updated_at: '2026-10-01T12:00:00Z',
			private: true,
			fork: false,
			archived: false
		}
	]
};

/**
 * `list_issues` (GraphQL): no URL, node id or author type; `comments` and
 * `labels` are left out when empty; never a pull request.
 */
export const LIST_ISSUES = {
	issues: [
		{
			number: 42,
			title: 'Crash on start',
			body: 'It crashes.',
			state: 'OPEN',
			user: { login: 'alice' },
			labels: ['bug'],
			assignees: [],
			comments: 2,
			created_at: '2026-10-20T08:00:00Z',
			updated_at: '2026-10-31T08:00:00Z'
		},
		{
			number: 41,
			title: 'My own note',
			state: 'OPEN',
			user: { login: 'OctoCat' },
			assignees: [],
			created_at: '2026-10-19T08:00:00Z',
			updated_at: '2026-10-30T08:00:00Z'
		},
		{
			number: 40,
			title: 'Bump deps',
			state: 'OPEN',
			user: { login: 'dependabot[bot]' },
			labels: ['dependencies'],
			assignees: [],
			created_at: '2026-10-18T08:00:00Z',
			updated_at: '2026-10-29T08:00:00Z'
		},
		{
			number: 39,
			title: 'Docs typo',
			state: 'OPEN',
			user: { login: 'bob' },
			labels: ['wontfix'],
			assignees: [],
			created_at: '2026-10-17T08:00:00Z',
			updated_at: '2026-10-28T08:00:00Z'
		},
		{
			number: 38,
			title: 'Feature idea',
			state: 'OPEN',
			user: { login: 'carol' },
			assignees: [],
			created_at: '2026-10-16T08:00:00Z',
			updated_at: '2026-10-27T08:00:00Z'
		}
	],
	totalCount: 5,
	pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: 'Y3', endCursor: 'Y4' }
};

/** `issue_read` `get`: a MinimalIssue, with `html_url` and the body. */
export const ISSUE_GET = {
	number: 42,
	title: 'Crash on start',
	body: 'It crashes when the config is empty.',
	state: 'open',
	html_url: 'https://github.com/octocat/app/issues/42',
	user: { login: 'alice', id: 1, profile_url: 'https://github.com/alice', avatar_url: 'x' },
	labels: ['bug'],
	assignees: [],
	comments: 2,
	created_at: '2026-10-20T08:00:00Z',
	updated_at: '2026-10-31T08:00:00Z'
};

/** `issue_read` `get_comments`: a bare array of MinimalIssueComment. */
export const ISSUE_COMMENTS = [
	{
		id: 123,
		body: 'Same here.',
		html_url: 'https://github.com/octocat/app/issues/42#issuecomment-123',
		user: { login: 'bob', id: 2, profile_url: 'https://github.com/bob', avatar_url: 'x' },
		author_association: 'NONE',
		created_at: '2026-10-21T08:00:00Z',
		updated_at: '2026-10-21T08:00:00Z'
	}
];

/** `search_pull_requests`: go-github's REST search result, unminimised. */
export const SEARCH_PULL_REQUESTS = {
	total_count: 1,
	incomplete_results: false,
	items: [
		{
			id: 9,
			node_id: 'PR_kwDOabc',
			number: 7,
			state: 'open',
			locked: false,
			title: 'Add a flag',
			user: { login: 'dave', id: 4, type: 'User', html_url: 'https://github.com/dave' },
			labels: [{ id: 1, name: 'needs review', color: 'ededed', default: false }],
			comments: 0,
			created_at: '2026-10-29T08:00:00Z',
			updated_at: '2026-10-31T09:00:00Z',
			url: 'https://api.github.com/repos/octocat/app/issues/7',
			html_url: 'https://github.com/octocat/app/pull/7',
			repository_url: 'https://api.github.com/repos/octocat/app',
			pull_request: {
				url: 'x',
				html_url: 'https://github.com/octocat/app/pull/7',
				merged_at: null
			},
			draft: false
		}
	]
};
