import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';

const mocks = vi.hoisted(() => ({
	list: [] as SkillSummary[],
	root: null as string | null,
	info: { skills: 0, agentsMd: false },
	agentsMd: null as unknown,
	ask: vi.fn(async () => true)
}));

vi.mock('@tauri-apps/api/core', () => ({
	invoke: vi.fn(async (cmd: string) => {
		if (cmd === 'skills_list') return mocks.list;
		if (cmd === 'skills_project_root') return mocks.root;
		if (cmd === 'skills_project_info') return mocks.info;
		if (cmd === 'skills_agents_md') return mocks.agentsMd;
		return null;
	})
}));
vi.mock('#lib/stores/repoTrust.svelte.ts', () => ({ askRepoTrust: mocks.ask }));

import { invoke } from '@tauri-apps/api/core';
import { defaultSkills, getSettings, updateSkills } from '#lib/stores/settings.ts';
import { prepareTurnSkills, skillsPromptSection } from './turn';
import { codeModeProject, trustedProjectRoot } from './project';

function skill(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
	return {
		name,
		description: `${name} desc`,
		source: 'user',
		dir: `/s/${name}`,
		license: null,
		compatibility: null,
		allowedTools: null,
		warnings: [],
		error: null,
		shadowed: false,
		createdByModel: false,
		...extra
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockClear();
	mocks.ask.mockClear().mockResolvedValue(true);
	mocks.list = [skill('deploy'), skill('broken', { error: 'no description' })];
	mocks.root = null;
	mocks.info = { skills: 0, agentsMd: false };
	mocks.agentsMd = null;
	updateSkills({ ...defaultSkills, autonomous: 'on', trustedRepos: {} });
});

describe('prepareTurnSkills', () => {
	it('lists only usable skills', async () => {
		const skills = await prepareTurnSkills({});
		expect(skills).toEqual({
			catalog: [{ name: 'deploy', description: 'deploy desc' }],
			projectRoot: null
		});
	});

	it('gives nothing, and asks nothing, when autonomous use is off', async () => {
		updateSkills({ autonomous: 'off' });
		expect(await prepareTurnSkills({ projectRoot: '/code/repo' })).toBeUndefined();
		expect(invoke).not.toHaveBeenCalled();
	});

	it('gives nothing when no skill is usable, or listing fails', async () => {
		mocks.list = [skill('x', { shadowed: true })];
		expect(await prepareTurnSkills({})).toBeUndefined();
		vi.mocked(invoke).mockRejectedValueOnce(new Error('disk gone'));
		expect(await prepareTurnSkills({})).toBeUndefined();
	});

	it("lists a trusted repo's skills for Code mode", async () => {
		updateSkills({ trustedRepos: { '/code/repo': true } });
		const skills = await prepareTurnSkills({ projectRoot: '/code/repo' });
		expect(skills?.projectRoot).toBe('/code/repo');
		expect(invoke).toHaveBeenCalledWith('skills_list', {
			extraDirs: [],
			projectRoot: '/code/repo'
		});
	});
});

describe('trustedProjectRoot', () => {
	it('is null outside a repo', async () => {
		expect(await trustedProjectRoot('/tmp')).toBeNull();
		expect(await trustedProjectRoot(null)).toBeNull();
	});

	it("doesn't ask about a repo with no skills, or record an answer", async () => {
		mocks.root = '/code/repo';
		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).not.toHaveBeenCalled();
		expect(getSettings().skills.trustedRepos).toEqual({});
	});

	it('asks once and remembers the answer', async () => {
		mocks.root = '/code/repo';
		mocks.info = { skills: 2, agentsMd: true };
		mocks.ask.mockResolvedValueOnce(false);
		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).toHaveBeenCalledWith({ root: '/code/repo', skills: 2, agentsMd: true });
		expect(getSettings().skills.trustedRepos).toEqual({ '/code/repo': false });

		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).toHaveBeenCalledTimes(1);
	});
});

describe('codeModeProject', () => {
	const md = {
		files: ['AGENTS.md'],
		text: 'From AGENTS.md:\nrules',
		truncated: false,
		totalBytes: 24
	};

	it('asks about a repo that has only an AGENTS.md, whatever the skills setting', async () => {
		updateSkills({ autonomous: 'off' });
		mocks.root = '/code/repo';
		mocks.info = { skills: 0, agentsMd: true };
		mocks.agentsMd = md;
		expect(await codeModeProject('/code/repo/src')).toEqual({ root: '/code/repo', agentsMd: md });
		expect(mocks.ask).toHaveBeenCalledWith({ root: '/code/repo', skills: 0, agentsMd: true });
		expect(invoke).toHaveBeenCalledWith('skills_agents_md', {
			root: '/code/repo',
			cwd: '/code/repo/src'
		});
	});

	it('reads nothing from a declined repo', async () => {
		mocks.root = '/code/repo';
		mocks.agentsMd = md;
		updateSkills({ trustedRepos: { '/code/repo': false } });
		expect(await codeModeProject('/code/repo')).toEqual({ root: null, agentsMd: null });
		expect(invoke).not.toHaveBeenCalledWith('skills_agents_md', expect.anything());
	});
});

describe('skillsPromptSection', () => {
	it('lists the skills and says how to load one', () => {
		const text = skillsPromptSection({
			catalog: [{ name: 'deploy', description: 'Ship it.' }],
			projectRoot: null
		});
		expect(text).toContain('SKILLS:');
		expect(text).toContain('- deploy: Ship it.');
		expect(text).toContain('load_skill');
		expect(skillsPromptSection(undefined)).toBe('');
	});
});
