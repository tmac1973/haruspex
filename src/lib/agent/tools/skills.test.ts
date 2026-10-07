import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';

const client = vi.hoisted(() => ({
	readSkill: vi.fn(),
	readSkillFile: vi.fn()
}));
vi.mock('#lib/skills/client.ts', () => client);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import type { ToolContext } from './types';

const doc: SkillDoc = {
	name: 'deploy',
	body: 'Run the deploy.',
	dir: '/s/deploy',
	compatibility: null,
	files: ['scripts/go.sh'],
	filesTruncated: false
};

function ctx(skills?: ToolContext['skills']): ToolContext {
	return { workingDir: null, pendingImages: [], skills } as unknown as ToolContext;
}

const turnSkills = (): NonNullable<ToolContext['skills']> => ({
	names: ['deploy'],
	projectRoot: '/code/repo',
	loaded: new Set()
});

beforeEach(() => {
	client.readSkill.mockReset().mockResolvedValue(doc);
	client.readSkillFile.mockReset().mockResolvedValue('#!/bin/sh');
});

describe('skills tool schemas', () => {
	const names = (opts: Parameters<typeof getToolSchemas>[0]) =>
		getToolSchemas(opts).map((s) => s.function.name);

	it('are offered only to a turn with skills, in any mode', () => {
		expect(names({ hasWorkingDir: false })).not.toContain('load_skill');
		expect(names({ hasWorkingDir: false, skillNames: [] })).not.toContain('load_skill');
		for (const mode of [{}, { shellMode: true }, { shellMode: true, codeMode: true }]) {
			const n = names({ hasWorkingDir: true, ...mode, skillNames: ['deploy'] });
			expect(n).toContain('load_skill');
			expect(n).toContain('read_skill_file');
		}
	});

	it("limit the name to the turn's skills", () => {
		const load = getToolSchemas({ hasWorkingDir: false, skillNames: ['a', 'b'] }).find(
			(s) => s.function.name === 'load_skill'
		)!;
		const params = load.function.parameters as {
			properties: { name: { enum?: string[] } };
		};
		expect(params.properties.name.enum).toEqual(['a', 'b']);
	});

	it('are never in a job allowlist by default', () => {
		expect(
			names({ hasWorkingDir: true, toolAllowlist: ['fs_read_text'], skillNames: ['deploy'] })
		).toEqual(['fs_read_text']);
	});
});

describe('load_skill', () => {
	it('returns the wrapped instructions and marks the skill loaded', async () => {
		const skills = turnSkills();
		const out = await executeTool('load_skill', { name: 'deploy' }, ctx(skills));
		expect(out.result).toContain('<skill_content name="deploy">');
		expect(out.result).toContain('Run the deploy.');
		expect(client.readSkill).toHaveBeenCalledWith('deploy', '/code/repo');
		expect(skills.loaded.has('deploy')).toBe(true);

		const again = await executeTool('load_skill', { name: 'deploy' }, ctx(skills));
		expect(again.result).toContain('already loaded');
		expect(client.readSkill).toHaveBeenCalledTimes(1);
	});

	it('refuses an unknown skill, or a turn without skills', async () => {
		const unknown = await executeTool('load_skill', { name: 'nope' }, ctx(turnSkills()));
		const { error } = JSON.parse(unknown.result) as { error: string };
		expect(error).toBe('No skill named "nope". Available: deploy.');
		const none = await executeTool('load_skill', { name: 'deploy' }, ctx());
		expect(none.result).toContain('not available');
		expect(client.readSkill).not.toHaveBeenCalled();
	});

	it('reports a read failure without throwing, and can try again', async () => {
		const skills = turnSkills();
		client.readSkill.mockRejectedValueOnce('no skill named "deploy"');
		const out = await executeTool('load_skill', { name: 'deploy' }, ctx(skills));
		expect(out.result).toContain('Could not load');
		expect(skills.loaded.has('deploy')).toBe(false);
	});

	it('loads one copy when two calls for the same skill run side by side', async () => {
		const skills = turnSkills();
		const [a, b] = await Promise.all([
			executeTool('load_skill', { name: 'deploy' }, ctx(skills)),
			executeTool('load_skill', { name: 'deploy' }, ctx(skills))
		]);
		expect(client.readSkill).toHaveBeenCalledTimes(1);
		expect([a.result, b.result].filter((r) => r.includes('<skill_content')).length).toBe(1);
	});
});

describe('read_skill_file', () => {
	it("reads a file from the skill's folder", async () => {
		const out = await executeTool(
			'read_skill_file',
			{ name: 'deploy', path: 'scripts/go.sh' },
			ctx(turnSkills())
		);
		expect(out.result).toBe('#!/bin/sh');
		expect(client.readSkillFile).toHaveBeenCalledWith('deploy', 'scripts/go.sh', '/code/repo');
	});

	it('passes a refusal back to the model', async () => {
		client.readSkillFile.mockRejectedValueOnce('"../x" leads outside the skill\'s folder');
		const out = await executeTool(
			'read_skill_file',
			{ name: 'deploy', path: '../x' },
			ctx(turnSkills())
		);
		expect(out.result).toContain('outside');
	});
});
