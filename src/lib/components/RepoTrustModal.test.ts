import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/svelte';
import { tick } from 'svelte';

import RepoTrustModal from './RepoTrustModal.svelte';
import {
	askRepoTrust,
	getPendingRepoTrust,
	resolveRepoTrust
} from '#lib/stores/repoTrust.svelte.ts';

afterEach(() => {
	while (getPendingRepoTrust()) resolveRepoTrust(false);
});

describe('RepoTrustModal', () => {
	it('asks the first time, and answers with the button pressed', async () => {
		render(RepoTrustModal);
		const answer = askRepoTrust({ root: '/code/repo', skills: 2, agentsMd: true });
		await tick();
		screen.getByText("Use this repo's instructions?");
		screen.getByText(/2 skills and an AGENTS.md/);
		await fireEvent.click(screen.getByText('Use them'));
		expect(await answer).toBe(true);
	});

	it('says when a different repo now sits at the path', async () => {
		render(RepoTrustModal);
		void askRepoTrust({
			root: '/code/repo',
			skills: 0,
			agentsMd: true,
			change: { kind: 'origin', was: 'git@x:me/repo.git', now: null }
		});
		await tick();
		screen.getByText('A different repo is in this folder');
		screen.getByText('git@x:me/repo.git');
		screen.getByText('no origin remote');
	});

	it('names the skills added since the user said yes', async () => {
		render(RepoTrustModal);
		void askRepoTrust({
			root: '/code/repo',
			skills: 3,
			agentsMd: false,
			change: { kind: 'skills', added: ['deploy', 'release'] }
		});
		await tick();
		screen.getByText('This repo has new skills');
		screen.getByText(/Added since you said yes: deploy, release/);
	});
});
