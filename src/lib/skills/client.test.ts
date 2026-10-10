import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn().mockResolvedValue([]) }));

import { invoke } from '@tauri-apps/api/core';
import {
	listSkills,
	readSkill,
	readSkillFile,
	repoKey,
	repoLabel,
	repoTrust,
	skillsAutonomous,
	usableSkills
} from './client';
import { defaultSkills, updateInferenceBackend, updateSkills } from '#lib/stores/settings.ts';

function skill(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
	return {
		name,
		description: `${name} does things`,
		source: 'user',
		dir: `/skills/${name}`,
		license: null,
		compatibility: null,
		allowedTools: null,
		warnings: [],
		error: null,
		shadowed: false,
		createdByModel: false,
		codeModeOnly: false,
		forGuidedPlanning: false,
		...extra
	};
}

beforeEach(() => {
	vi.mocked(invoke).mockClear();
	updateSkills({ ...defaultSkills, trustedRepos: {} });
	updateInferenceBackend({ mode: 'local' });
});

describe('which folders Rust searches', () => {
	it('passes the project only when the repo is trusted', async () => {
		updateSkills({ extraDirs: ['~/.claude/skills'] });
		await listSkills('/code/repo');
		expect(invoke).toHaveBeenLastCalledWith('skills_list', {
			extraDirs: ['~/.claude/skills'],
			projectRoot: null
		});

		updateSkills({ trustedRepos: { '/code/repo': { trusted: true } } });
		await readSkill('deploy', '/code/repo');
		expect(invoke).toHaveBeenLastCalledWith('skill_read', {
			name: 'deploy',
			extraDirs: ['~/.claude/skills'],
			projectRoot: '/code/repo'
		});
	});

	it('treats a declined repo like an unasked one', async () => {
		updateSkills({ trustedRepos: { '/code/repo': { trusted: false } } });
		await readSkillFile('deploy', 'scripts/run.sh', '/code/repo');
		expect(vi.mocked(invoke).mock.calls[0][1]).toMatchObject({ projectRoot: null });
		expect(repoTrust('/code/repo')).toBe(false);
		expect(repoTrust('/elsewhere')).toBeUndefined();
	});
});

describe('usableSkills', () => {
	it('drops broken, overridden and switched-off skills', () => {
		updateSkills({ disabled: ['off'] });
		const names = usableSkills([
			skill('ok'),
			skill('broken', { error: 'no description' }),
			skill('old', { shadowed: true }),
			skill('off'),
			skill('warned', { warnings: ['name does not match its folder'] })
		]).map((s) => s.name);
		expect(names).toEqual(['ok', 'warned']);
	});
});

describe('usableSkills in and out of Code mode', () => {
	it('keeps a Code mode skill to Code mode, whatever its name', () => {
		const init = skill('init', { codeModeOnly: true });
		expect(usableSkills([init])).toEqual([]);
		expect(usableSkills([init], true)).toEqual([init]);
		expect(usableSkills([skill('init')])).toHaveLength(1);
	});
});

describe('skillsAutonomous', () => {
	it('auto is off for the local model and on for a remote one', () => {
		expect(skillsAutonomous()).toBe(false);
		updateInferenceBackend({ mode: 'remote', remoteBaseUrl: 'http://compute:3000' });
		expect(skillsAutonomous()).toBe(true);
		// A job's own server decides, not the global one.
		updateInferenceBackend({ mode: 'local' });
		expect(skillsAutonomous({ baseUrl: 'http://compute:3000' })).toBe(true);
	});

	it('an explicit choice wins', () => {
		updateSkills({ autonomous: 'on' });
		expect(skillsAutonomous()).toBe(true);
		updateInferenceBackend({ mode: 'remote', remoteBaseUrl: 'http://compute:3000' });
		updateSkills({ autonomous: 'off' });
		expect(skillsAutonomous()).toBe(false);
	});
});

describe('repoKey', () => {
	it('records a WSL repo by distro and Linux path, however its share is spelled', () => {
		const key = 'wsl:Ubuntu:/home/tim/proj';
		for (const root of [
			String.raw`\\wsl.localhost\Ubuntu\home\tim\proj`,
			String.raw`\\wsl$\Ubuntu\home\tim\proj` + '\\',
			String.raw`\\?\UNC\wsl.localhost\Ubuntu\home\tim\proj`
		]) {
			expect(repoKey(root)).toBe(key);
		}
		expect(repoKey('/home/tim/proj')).toBe('/home/tim/proj');
		// And as a person reads it, from either form.
		expect(repoLabel(String.raw`\\wsl.localhost\Ubuntu\home\tim\proj`)).toBe(
			'/home/tim/proj (Ubuntu)'
		);
		expect(repoLabel(key)).toBe('/home/tim/proj (Ubuntu)');
		expect(repoLabel('/home/tim/proj')).toBe('/home/tim/proj');
		expect(repoKey(String.raw`C:\code\proj`)).toBe(String.raw`C:\code\proj`);
	});
});
