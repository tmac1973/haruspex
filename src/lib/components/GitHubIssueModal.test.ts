import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';

const m = vi.hoisted(() => ({
	createIssue: vi.fn(),
	commentOn: vi.fn(),
	issueTitle: vi.fn(),
	repoLabels: vi.fn(),
	myRepos: vi.fn(),
	showToast: vi.fn()
}));

vi.mock('#lib/github/issues.ts', async (orig) => ({
	...(await orig<typeof import('#lib/github/issues.ts')>()),
	createIssue: m.createIssue,
	commentOn: m.commentOn,
	issueTitle: m.issueTitle,
	repoLabels: m.repoLabels,
	myRepos: m.myRepos,
	recentRepos: () => ['tmac1973/haruspex']
}));
vi.mock('#lib/stores/toasts.svelte.ts', () => ({ showToast: m.showToast }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import GitHubIssueModal from './GitHubIssueModal.svelte';
import { closeGitHubFile, getGitHubFile, openGitHubFile } from '#lib/stores/githubIssue.svelte.ts';

const field = (name: string) => screen.getByLabelText(name) as HTMLInputElement;

beforeEach(() => {
	for (const f of Object.values(m)) f.mockReset();
	m.myRepos.mockResolvedValue(['tmac1973/other']);
	m.repoLabels.mockResolvedValue(['bug', 'notebooks']);
	m.issueTitle.mockResolvedValue('Notebooks tab');
	closeGitHubFile();
});

async function open(mode: 'issue' | 'comment' = 'issue') {
	render(GitHubIssueModal);
	openGitHubFile({ title: 'Trip', body: '| a |\n|---|\n| 1 |\n', mode });
	await screen.findByText('File on GitHub');
}

describe('File on GitHub', () => {
	it('opens an issue in the last repository, with a label picked', async () => {
		m.createIssue.mockResolvedValue('https://github.com/tmac1973/haruspex/issues/50');
		await open();
		expect(field('Repository').value).toBe('tmac1973/haruspex');
		expect(field('Title').value).toBe('Trip');
		await fireEvent.click(await screen.findByRole('button', { name: 'bug' }, { timeout: 2000 }));
		expect(field('Labels').value).toBe('bug');
		await fireEvent.click(screen.getByText('Create issue'));

		await waitFor(() => expect(getGitHubFile()).toBeNull());
		expect(m.createIssue).toHaveBeenCalledWith(
			{ owner: 'tmac1973', repo: 'haruspex' },
			'Trip',
			'| a |\n|---|\n| 1 |\n',
			['bug']
		);
		expect(m.showToast).toHaveBeenCalledWith(
			'Opened an issue in tmac1973/haruspex.',
			expect.objectContaining({ actionLabel: 'Open' })
		);
	});

	it('comments on the issue a link names, and shows its title', async () => {
		m.commentOn.mockResolvedValue('https://github.com/tmac1973/haruspex/issues/1227');
		await open('comment');
		expect((screen.getByText('Add comment') as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.input(field('Issue'), {
			target: { value: 'https://github.com/tmac1973/haruspex/issues/1227' }
		});
		expect(field('Repository').disabled).toBe(true);
		await screen.findByText('Notebooks tab', {}, { timeout: 2000 });
		await fireEvent.click(screen.getByText('Add comment'));
		await waitFor(() =>
			expect(m.commentOn).toHaveBeenCalledWith(
				{ owner: 'tmac1973', repo: 'haruspex' },
				1227,
				'| a |\n|---|\n| 1 |\n'
			)
		);
	});

	it('stays open with the error when GitHub refuses', async () => {
		m.createIssue.mockRejectedValue(new Error('Resource not accessible by personal access token'));
		await open();
		await fireEvent.click(screen.getByText('Create issue'));
		await screen.findByText(/not accessible/);
		expect(getGitHubFile()).not.toBeNull();
	});

	it('will not send a repository it cannot read, or an over-long body', async () => {
		await open();
		await fireEvent.input(field('Repository'), { target: { value: 'haruspex' } });
		screen.getByText('Write the repository as owner/name.');
		expect((screen.getByText('Create issue') as HTMLButtonElement).disabled).toBe(true);
		await fireEvent.input(field('Repository'), { target: { value: 'tmac1973/haruspex' } });
		await fireEvent.input(field('Body'), { target: { value: 'x'.repeat(70_000) } });
		screen.getByText(/over GitHub's/);
		expect((screen.getByText('Create issue') as HTMLButtonElement).disabled).toBe(true);
	});
});
