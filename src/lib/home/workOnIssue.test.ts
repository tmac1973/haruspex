import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GitHubItem } from '#lib/home/github.ts';

const m = vi.hoisted(() => ({
	checkout: '/home/me/app' as string | null,
	body: 'It crashes.' as string | Error,
	session: { prefill: null as unknown },
	invoke: vi.fn(),
	openCodeSessionAt: vi.fn(),
	newJobDraft: vi.fn(),
	setActiveTab: vi.fn(),
	showToast: vi.fn()
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: m.invoke }));
vi.mock('#lib/code/db.ts', () => ({
	listCodeSessions: async () => [
		{ root: '/old/app', updated_at: 1, wsl_distro: null },
		{ root: '/home/me/app', updated_at: 9, wsl_distro: null },
		{ root: '/home/me/app', updated_at: 5, wsl_distro: null },
		{ root: '/linux/app', updated_at: 8, wsl_distro: 'Ubuntu' }
	]
}));
vi.mock('#lib/home/github.ts', () => ({
	readIssueBody: async () => {
		if (m.body instanceof Error) throw m.body;
		return m.body;
	}
}));
vi.mock('#lib/agent/jobs/types/index.ts', () => ({
	getJobType: () => ({ configDefaults: () => ({ initial_description: null, depth: 'normal' }) })
}));
vi.mock('#lib/stores/code.svelte.ts', () => ({ openCodeSessionAt: m.openCodeSessionAt }));
vi.mock('#lib/stores/jobsTabSelection.svelte.ts', () => ({ newJobDraft: m.newJobDraft }));
vi.mock('#lib/stores/activeTab.svelte.ts', () => ({ setActiveTab: m.setActiveTab }));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: m.showToast }));

import { openSessionOnIssue, planIssue } from './workOnIssue';

const issue: GitHubItem = {
	id: 'octocat/app#42',
	repo: 'octocat/app',
	number: 42,
	title: 'Crash on start',
	url: 'https://github.com/octocat/app/issues/42',
	author: 'alice',
	labels: [],
	comments: 0,
	updatedAt: '',
	isPr: false
};

beforeEach(() => {
	vi.clearAllMocks();
	m.checkout = '/home/me/app';
	m.body = 'It crashes.';
	m.session = { prefill: null };
	m.invoke.mockImplementation(async () => m.checkout);
	m.openCodeSessionAt.mockImplementation(async () => m.session);
});

describe('Work on this', () => {
	it('looks for the checkout in host session folders, newest first, once each', async () => {
		await openSessionOnIssue(issue);
		expect(m.invoke).toHaveBeenCalledWith('code_checkout_find', {
			repo: 'octocat/app',
			roots: ['/home/me/app', '/old/app']
		});
	});

	it('opens a session there with the issue in the input box, unsent', async () => {
		await openSessionOnIssue(issue);
		expect(m.openCodeSessionAt).toHaveBeenCalledWith('/home/me/app');
		expect(m.session.prefill).toEqual({
			text:
				'Work on octocat/app#42: Crash on start\n\nIt crashes.\n\n' +
				'https://github.com/octocat/app/issues/42',
			images: []
		});
	});

	it('drafts a guided-planning job in the checkout, unsaved', async () => {
		await planIssue(issue);
		expect(m.newJobDraft).toHaveBeenCalledWith({
			jobType: 'guided_planning',
			name: 'octocat/app#42',
			workingDir: '/home/me/app',
			config: {
				depth: 'normal',
				initial_description:
					'Crash on start\n\nIt crashes.\n\nhttps://github.com/octocat/app/issues/42'
			}
		});
		expect(m.setActiveTab).toHaveBeenCalledWith('jobs');
	});

	it('says so and stops with no checkout, or when the issue cannot be read', async () => {
		m.checkout = null;
		await openSessionOnIssue(issue);
		expect(m.showToast).toHaveBeenCalledWith(
			'No local checkout of octocat/app found. Open it once in the Code tab.',
			{ kind: 'error' }
		);
		m.checkout = '/home/me/app';
		m.body = new Error('404');
		await planIssue(issue);
		expect(m.showToast).toHaveBeenLastCalledWith("Couldn't read octocat/app#42 from GitHub.", {
			kind: 'error'
		});
		expect(m.openCodeSessionAt).not.toHaveBeenCalled();
		expect(m.newJobDraft).not.toHaveBeenCalled();
	});
});
