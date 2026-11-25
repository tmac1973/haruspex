import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({ call: vi.fn(), notice: vi.fn() }));

vi.mock('#lib/home/github.ts', () => ({
	callGitHubTool: m.call,
	serverNotice: m.notice
}));

import {
	_resetForTests,
	commentOn,
	createIssue,
	githubReady,
	labelNames,
	linkIn,
	MAX_BODY_CHARS,
	myRepos,
	parseIssue,
	parseRepo,
	recentRepos
} from './issues';

const repo = { owner: 'tmac1973', repo: 'haruspex' };

beforeEach(() => {
	m.call.mockReset();
	m.notice.mockReset();
	localStorage.clear();
	_resetForTests();
});

describe('reading what was typed', () => {
	it('takes a repository as owner/name or a link into it', () => {
		expect(parseRepo(' tmac1973/haruspex ')).toEqual(repo);
		expect(parseRepo('https://github.com/tmac1973/haruspex/issues/3')).toEqual(repo);
		expect(parseRepo('https://github.com/tmac1973/haruspex.git')).toEqual(repo);
		expect(parseRepo('haruspex')).toBeNull();
	});

	it('takes an issue as a number, #number, or a link that names its repository', () => {
		expect(parseIssue('12')).toEqual({ number: 12 });
		expect(parseIssue('#12')).toEqual({ number: 12 });
		expect(parseIssue('https://github.com/tmac1973/haruspex/pull/9')).toEqual({
			number: 9,
			repo
		});
		expect(parseIssue('twelve')).toBeNull();
	});
});

describe('GitHub replies', () => {
	it('finds label names in a list or under labels', () => {
		expect(labelNames([{ name: 'bug' }, { name: 'docs' }])).toEqual(['bug', 'docs']);
		expect(labelNames({ labels: [{ name: 'bug' }], totalCount: 1 })).toEqual(['bug']);
		expect(labelNames(['bug'])).toEqual(['bug']);
		expect(labelNames(null)).toEqual([]);
	});

	it('finds the link a write made, or builds it from the number', () => {
		expect(linkIn('{"url":"https://github.com/tmac1973/haruspex/issues/40"}', repo)).toBe(
			'https://github.com/tmac1973/haruspex/issues/40'
		);
		expect(
			linkIn('{"html_url":"https://github.com/tmac1973/haruspex/issues/4#issuecomment-9"}', repo)
		).toBe('https://github.com/tmac1973/haruspex/issues/4#issuecomment-9');
		expect(linkIn('{"number": 41}', repo)).toBe('https://github.com/tmac1973/haruspex/issues/41');
		expect(linkIn('ok', repo, 7)).toBe('https://github.com/tmac1973/haruspex/issues/7');
	});
});

describe('writing to GitHub', () => {
	it('opens an issue with its labels and remembers the repository', async () => {
		m.call.mockResolvedValue('{"url":"https://github.com/tmac1973/haruspex/issues/50"}');
		const link = await createIssue(repo, ' Trip ', 'Body', ['bug']);
		expect(m.call).toHaveBeenCalledWith('issue_write', {
			method: 'create',
			owner: 'tmac1973',
			repo: 'haruspex',
			title: 'Trip',
			body: 'Body',
			labels: ['bug']
		});
		expect(link).toBe('https://github.com/tmac1973/haruspex/issues/50');
		expect(recentRepos()).toEqual(['tmac1973/haruspex']);
	});

	it('comments on an issue', async () => {
		m.call.mockResolvedValue('{}');
		const link = await commentOn(repo, 12, 'More');
		expect(m.call).toHaveBeenCalledWith('add_issue_comment', {
			owner: 'tmac1973',
			repo: 'haruspex',
			issue_number: 12,
			body: 'More'
		});
		expect(link).toBe('https://github.com/tmac1973/haruspex/issues/12');
	});

	it('refuses a body GitHub would refuse, without calling it', async () => {
		await expect(createIssue(repo, 't', 'x'.repeat(MAX_BODY_CHARS + 1), [])).rejects.toThrow(
			/at most/
		);
		expect(m.call).not.toHaveBeenCalled();
	});

	it('lists the token owner’s repositories once', async () => {
		m.call.mockImplementation(async (name: string) =>
			name === 'get_me'
				? '{"login":"tmac1973"}'
				: '{"items":[{"full_name":"tmac1973/haruspex"},{"full_name":"tmac1973/other"}]}'
		);
		expect(await myRepos()).toEqual(['tmac1973/haruspex', 'tmac1973/other']);
		await myRepos();
		expect(m.call).toHaveBeenCalledTimes(2);
	});

	it('is ready only when the server is running', () => {
		m.notice.mockReturnValue(null);
		expect(githubReady()).toBe(true);
		m.notice.mockReturnValue('Start GitHub in Settings → MCP servers.');
		expect(githubReady()).toBe(false);
	});
});
