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

import { noteProjectSkill } from './project';

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
