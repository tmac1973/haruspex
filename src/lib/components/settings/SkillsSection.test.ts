import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { invoke } from '@tauri-apps/api/core';
import type { SkillSummary } from '#lib/ipc/gen/SkillSummary.ts';
import SkillsSection from './SkillsSection.svelte';
import { defaultSkills, getSettings, updateSkills } from '#lib/stores/settings.ts';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ open: vi.fn(async () => '/picked/skills') }));

function skill(name: string, extra: Partial<SkillSummary> = {}): SkillSummary {
	return {
		name,
		description: `${name} description`,
		source: 'user',
		dir: `/data/skills/${name}`,
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

let listed: SkillSummary[];

beforeEach(() => {
	vi.clearAllMocks();
	updateSkills({ ...defaultSkills, trustedRepos: {} });
	listed = [
		skill('deploy', { createdByModel: true }),
		skill('broken', { source: 'extra', error: 'no description', description: '' }),
		skill('shared', { source: 'shared', warnings: ['name does not match its folder "x"'] })
	];
	vi.mocked(invoke).mockImplementation(async (cmd: string) => {
		if (cmd === 'skills_list') return listed;
		if (cmd === 'skill_read') return { name: 'deploy', body: 'Run it.', files: [] };
		if (cmd === 'skill_delete_user') {
			listed = listed.filter((s) => s.name !== 'deploy');
			return undefined;
		}
		return undefined;
	});
});

describe('Settings → Skills', () => {
	it('lists skills with their source, problems and badges', async () => {
		render(SkillsSection);
		expect(await screen.findByText('deploy')).toBeTruthy();
		expect(screen.getByText('Written by the model')).toBeTruthy();
		expect(screen.getByText('Not usable: no description.')).toBeTruthy();
		expect(screen.getByText('name does not match its folder "x"')).toBeTruthy();
		// Only skills in Haruspex's own folder can be deleted.
		expect(screen.getAllByText('Delete')).toHaveLength(1);
	});

	it('switches a skill off and on', async () => {
		render(SkillsSection);
		await screen.findByText('deploy');
		const toggle = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
		await fireEvent.click(toggle);
		expect(getSettings().skills.disabled).toEqual(['deploy']);
		await fireEvent.click(toggle);
		expect(getSettings().skills.disabled).toEqual([]);
	});

	it('deletes a user skill after confirming', async () => {
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		render(SkillsSection);
		await fireEvent.click(await screen.findByText('Delete'));
		expect(invoke).toHaveBeenCalledWith('skill_delete_user', { name: 'deploy' });
		await waitFor(() => expect(screen.queryByText('deploy')).toBeNull());
	});

	it('adds and removes extra folders', async () => {
		render(SkillsSection);
		await fireEvent.click(await screen.findByText('Add ~/.claude/skills'));
		await fireEvent.click(screen.getByText('Add folder…'));
		await waitFor(() =>
			expect(getSettings().skills.extraDirs).toEqual(['~/.claude/skills', '/picked/skills'])
		);
		await fireEvent.click(screen.getAllByText('Remove')[0]);
		expect(getSettings().skills.extraDirs).toEqual(['/picked/skills']);
	});

	it('changes or forgets a repo decision', async () => {
		updateSkills({ trustedRepos: { '/code/repo': true } });
		render(SkillsSection);
		const select = (await screen.findByDisplayValue('Use')) as HTMLSelectElement;
		await fireEvent.change(select, { target: { value: 'ignore' } });
		expect(getSettings().skills.trustedRepos).toEqual({ '/code/repo': false });
		await fireEvent.click(screen.getByText('Forget'));
		expect(getSettings().skills.trustedRepos).toEqual({});
	});

	it('sets when the model uses skills', async () => {
		render(SkillsSection);
		const select = screen.getByDisplayValue('Automatic (remote models only)');
		await fireEvent.change(select, { target: { value: 'off' } });
		expect(getSettings().skills.autonomous).toBe('off');
	});
});
