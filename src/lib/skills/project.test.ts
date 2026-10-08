import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RepoTrust } from '#lib/stores/settings.ts';

const settings = vi.hoisted(() => ({
	repos: {} as Record<string, RepoTrust>,
	updateSkills: vi.fn()
}));
vi.mock('#lib/stores/settings.ts', () => ({
	getSettings: () => ({ skills: { trustedRepos: settings.repos } }),
	updateSkills: settings.updateSkills
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));

import { invoke } from '@tauri-apps/api/core';
import { knownShellProject, noteProjectSkill, trustApprovedAgentsMd } from './project';

beforeEach(() => {
	settings.updateSkills.mockReset();
});

describe('noteProjectSkill', () => {
	it("adds a saved skill to a trusted repo's record, so it isn't asked about", () => {
		settings.repos = { '/r': { trusted: true, origin: 'u', skills: ['b'] } };
		noteProjectSkill('/r', 'a');
		expect(settings.updateSkills).toHaveBeenCalledWith({
			trustedRepos: { '/r': { trusted: true, origin: 'u', skills: ['a', 'b'] } }
		});
	});

	it('leaves records alone that have nothing to add to', () => {
		settings.repos = {
			'/known': { trusted: true, skills: ['a'] },
			'/old': { trusted: true },
			'/no': { trusted: false, skills: [] }
		};
		for (const root of ['/known', '/old', '/no', '/unknown']) noteProjectSkill(root, 'a');
		expect(settings.updateSkills).not.toHaveBeenCalled();
	});
});

describe('trustApprovedAgentsMd', () => {
	function repo(info: { skillNames: string[]; origin: string | null } | null) {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === 'skills_project_root') return '/r';
			if (cmd === 'skills_project_info') return info && { ...info, agentsMd: true };
			return null;
		});
	}

	it('trusts a repo never asked about, as the user just approved its file', async () => {
		settings.repos = {};
		repo({ skillNames: [], origin: 'u' });
		expect(await trustApprovedAgentsMd('/r/src')).toBe(true);
		expect(settings.updateSkills).toHaveBeenCalledWith({
			trustedRepos: { '/r': { trusted: true, origin: 'u', skills: [] } }
		});
	});

	it('stands by an earlier answer, a no included', async () => {
		repo({ skillNames: [], origin: 'u' });
		settings.repos = { '/r': { trusted: false } };
		expect(await trustApprovedAgentsMd('/r')).toBe(false);
		settings.repos = { '/r': { trusted: true } };
		expect(await trustApprovedAgentsMd('/r')).toBe(true);
		expect(settings.updateSkills).not.toHaveBeenCalled();
	});

	it('leaves skills the user has not seen to the trust prompt', async () => {
		settings.repos = {};
		repo({ skillNames: ['x'], origin: null });
		expect(await trustApprovedAgentsMd('/r')).toBe(false);
		expect(settings.updateSkills).not.toHaveBeenCalled();
	});
});

describe('knownShellProject', () => {
	const md = { files: ['AGENTS.md'], text: 'x', truncated: false, totalBytes: 1 };
	beforeEach(() => {
		vi.mocked(invoke).mockImplementation(async (cmd: string) => {
			if (cmd === 'skills_project_root') return '/r';
			if (cmd === 'skills_agents_md') return md;
			return null;
		});
	});

	it("reads a trusted repo's AGENTS.md without asking", async () => {
		settings.repos = { '/r': { trusted: true } };
		expect(await knownShellProject('/r/src')).toEqual({ root: '/r', agentsMd: md });
	});

	it('gives nothing for a repo not trusted, or never asked about', async () => {
		const answers: Record<string, RepoTrust>[] = [{ '/r': { trusted: false } }, {}];
		for (const repos of answers) {
			settings.repos = repos;
			expect(await knownShellProject('/r')).toEqual({ root: null, agentsMd: null });
		}
		expect(settings.updateSkills).not.toHaveBeenCalled();
	});
});
