import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';

const mocks = vi.hoisted(() => ({
	list: [] as SkillSummary[],
	root: null as string | null,
	info: { skillNames: [] as string[], agentsMd: false, origin: null as string | null },
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
import { shellProject, trustedProjectRoot } from './project';

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
		codeModeOnly: false,
		...extra
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockClear();
	mocks.ask.mockClear().mockResolvedValue(true);
	mocks.list = [skill('deploy'), skill('broken', { error: 'no description' })];
	mocks.root = null;
	mocks.info = { skillNames: [], agentsMd: false, origin: null };
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

	it('lists the built-in init only in Code mode', async () => {
		mocks.list.push(skill('init', { codeModeOnly: true }));
		const names = async (codeMode: boolean) =>
			(await prepareTurnSkills({ codeMode })).catalog.map((s) => s.name);
		expect(await names(false)).not.toContain('init');
		expect(await names(true)).toContain('init');
	});

	it('lists nothing, and asks nothing, when autonomous use is off', async () => {
		// The turn still carries skills: one run with `/name` may read its files.
		updateSkills({ autonomous: 'off' });
		expect(await prepareTurnSkills({ projectRoot: '/code/repo' })).toEqual({
			catalog: [],
			projectRoot: '/code/repo'
		});
		expect(invoke).not.toHaveBeenCalled();
	});

	it('lists nothing when no skill is usable, or listing fails', async () => {
		mocks.list = [skill('x', { shadowed: true })];
		expect((await prepareTurnSkills({})).catalog).toEqual([]);
		vi.mocked(invoke).mockRejectedValueOnce(new Error('disk gone'));
		expect((await prepareTurnSkills({})).catalog).toEqual([]);
		expect(skillsPromptSection({ catalog: [], projectRoot: null })).toBe('');
	});

	it("lists a trusted repo's skills for Code mode", async () => {
		updateSkills({ trustedRepos: { '/code/repo': { trusted: true } } });
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
		mocks.info = { skillNames: ['a', 'b'], agentsMd: true, origin: 'git@x:me/repo.git' };
		mocks.ask.mockResolvedValueOnce(false);
		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).toHaveBeenCalledWith({ root: '/code/repo', skills: 2, agentsMd: true });
		expect(getSettings().skills.trustedRepos).toEqual({
			'/code/repo': { trusted: false, origin: 'git@x:me/repo.git', skills: ['a', 'b'] }
		});

		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).toHaveBeenCalledTimes(1);
	});
});

describe('trustedProjectRoot — when an answer no longer fits', () => {
	const origin = 'git@x:me/repo.git';
	const answer = (trusted: boolean, skills = ['a']) => ({ trusted, origin, skills });
	beforeEach(() => {
		mocks.root = '/code/repo';
		mocks.info = { skillNames: ['a'], agentsMd: true, origin };
	});

	it('asks again when a different repo sits at the path, trusted or not', async () => {
		for (const trusted of [true, false]) {
			mocks.ask.mockClear();
			updateSkills({ trustedRepos: { '/code/repo': answer(trusted) } });
			mocks.info = { skillNames: ['a'], agentsMd: true, origin: 'git@x:else/other.git' };
			mocks.ask.mockResolvedValueOnce(true);
			expect(await trustedProjectRoot('/code/repo')).toBe('/code/repo');
			expect(mocks.ask).toHaveBeenCalledWith(
				expect.objectContaining({
					change: { kind: 'origin', was: origin, now: 'git@x:else/other.git' }
				})
			);
			expect(getSettings().skills.trustedRepos['/code/repo'].origin).toBe('git@x:else/other.git');
		}
	});

	it('asks again when a trusted repo gains a skill, naming it', async () => {
		updateSkills({ trustedRepos: { '/code/repo': answer(true) } });
		mocks.info = { skillNames: ['a', 'deploy'], agentsMd: true, origin };
		mocks.ask.mockResolvedValueOnce(false);
		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).toHaveBeenCalledWith(
			expect.objectContaining({ change: { kind: 'skills', added: ['deploy'] } })
		);
		expect(getSettings().skills.trustedRepos['/code/repo']).toEqual(answer(false, ['a', 'deploy']));
	});

	it("doesn't ask about new skills in a repo the user ignores", async () => {
		updateSkills({ trustedRepos: { '/code/repo': answer(false) } });
		mocks.info = { skillNames: ['a', 'deploy'], agentsMd: true, origin };
		expect(await trustedProjectRoot('/code/repo')).toBeNull();
		expect(mocks.ask).not.toHaveBeenCalled();
	});

	it('keeps the record current without asking: removed skills, older answers', async () => {
		updateSkills({ trustedRepos: { '/code/repo': answer(true, ['a', 'gone']) } });
		expect(await trustedProjectRoot('/code/repo')).toBe('/code/repo');
		expect(getSettings().skills.trustedRepos['/code/repo']).toEqual(answer(true, ['a']));

		// An answer from before origins were recorded is taken as it stands.
		updateSkills({ trustedRepos: { '/code/repo': { trusted: true } } });
		mocks.info = { skillNames: ['a', 'b'], agentsMd: true, origin };
		expect(await trustedProjectRoot('/code/repo')).toBe('/code/repo');
		expect(getSettings().skills.trustedRepos['/code/repo']).toEqual(answer(true, ['a', 'b']));
		expect(mocks.ask).not.toHaveBeenCalled();
	});
});

describe('shellProject', () => {
	const md = {
		files: ['AGENTS.md'],
		text: 'From AGENTS.md:\nrules',
		truncated: false,
		totalBytes: 24
	};

	it('asks about a repo that has only an AGENTS.md, whatever the skills setting', async () => {
		updateSkills({ autonomous: 'off' });
		mocks.root = '/code/repo';
		mocks.info = { skillNames: [], agentsMd: true, origin: null };
		mocks.agentsMd = md;
		expect(await shellProject('/code/repo/src')).toEqual({ root: '/code/repo', agentsMd: md });
		expect(mocks.ask).toHaveBeenCalledWith({ root: '/code/repo', skills: 0, agentsMd: true });
		expect(invoke).toHaveBeenCalledWith('skills_agents_md', {
			root: '/code/repo',
			cwd: '/code/repo/src'
		});
	});

	it('reads nothing from a declined repo', async () => {
		mocks.root = '/code/repo';
		mocks.agentsMd = md;
		updateSkills({ trustedRepos: { '/code/repo': { trusted: false } } });
		expect(await shellProject('/code/repo')).toEqual({ root: null, agentsMd: null });
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
		expect(text).toContain('without calling load_skill');
		expect(skillsPromptSection(undefined)).toBe('');
	});
});
