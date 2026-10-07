import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDraft } from '#lib/ipc/gen/SkillDraft.ts';

const client = vi.hoisted(() => ({
	readSkill: vi.fn(),
	readSkillFile: vi.fn(),
	draftSkill: vi.fn(),
	saveSkill: vi.fn()
}));
vi.mock('#lib/skills/client.ts', () => client);
const project = vi.hoisted(() => ({ noteProjectSkill: vi.fn() }));
vi.mock('#lib/skills/project.ts', () => project);

import { executeTool, getToolSchemas } from '#lib/agent/tools/index.ts';
import { getPendingSkillApproval, resolveSkillApproval } from '#lib/stores/skillApproval.svelte.ts';
import type { ToolContext } from './types';

const draft: SkillDraft = {
	dir: '/data/skills/deploy-check',
	text: '---\nname: deploy-check\n---\n\nRun the checks.\n',
	current: null
};

function ctx(over: Partial<ToolContext> = {}): ToolContext {
	return {
		workingDir: null,
		pendingImages: [],
		interactive: true,
		codeMode: false,
		skills: { names: [], readable: [], projectRoot: '/code/repo', loaded: new Set() },
		...over
	} as unknown as ToolContext;
}

const createArgs = {
	name: 'deploy-check',
	description: 'Check a deploy.',
	body: 'Run the checks.'
};

/** Run a tool and, once its approval is pending, answer it with `answer`. */
async function runAnswering(
	name: string,
	args: Record<string, unknown>,
	answer: (pending: NonNullable<ReturnType<typeof getPendingSkillApproval>>) => Promise<void>,
	c = ctx()
) {
	const run = executeTool(name, args, c);
	await vi.waitFor(() => expect(getPendingSkillApproval()).not.toBeNull());
	await answer(getPendingSkillApproval()!);
	return (await run).result;
}

beforeEach(() => {
	client.draftSkill.mockReset().mockResolvedValue(draft);
	client.saveSkill.mockReset().mockResolvedValue('/data/skills/deploy-check/SKILL.md');
	project.noteProjectSkill.mockReset();
	resolveSkillApproval({ kind: 'rejected', reason: '' });
});

describe('skill writing schemas', () => {
	const names = (opts: Parameters<typeof getToolSchemas>[0]) =>
		getToolSchemas(opts).map((s) => s.function.name);

	it('are offered to an interactive turn with skills, autonomous use or not', () => {
		const n = names({ hasWorkingDir: false, interactive: true, hasSkills: true, skillNames: [] });
		expect(n).toContain('create_skill');
		expect(n).toContain('update_skill');
	});

	it('are never offered to jobs or remote turns', () => {
		expect(names({ hasWorkingDir: false, interactive: false, hasSkills: true })).not.toContain(
			'create_skill'
		);
		expect(names({ hasWorkingDir: false, interactive: true })).not.toContain('create_skill');
		const allowlisted = names({
			hasWorkingDir: true,
			interactive: true,
			hasSkills: true,
			toolAllowlist: ['create_skill', 'update_skill', 'fs_read_text']
		});
		expect(allowlisted).toEqual(['fs_read_text']);
	});

	it('offer a project destination only in Code mode', () => {
		const where = (codeMode: boolean) => {
			const schema = getToolSchemas({
				hasWorkingDir: true,
				interactive: true,
				hasSkills: true,
				shellMode: true,
				codeMode
			}).find((s) => s.function.name === 'create_skill')!;
			const params = schema.function.parameters as { properties: Record<string, unknown> };
			return 'where' in params.properties;
		};
		expect(where(true)).toBe(true);
		expect(where(false)).toBe(false);
	});
});

describe('create_skill and update_skill', () => {
	it('return a turned-back request to the model without asking the user', async () => {
		client.draftSkill.mockRejectedValue('"Deploy" is not a valid skill name');
		const out = await executeTool('create_skill', { ...createArgs, name: 'Deploy' }, ctx());
		expect(out.result).toContain('not a valid skill name');
		expect(getPendingSkillApproval()).toBeNull();
		expect(client.saveSkill).not.toHaveBeenCalled();
	});

	it('save the text the user approved, edits included', async () => {
		const result = await runAnswering('create_skill', createArgs, async (p) => {
			expect(p.text).toBe(draft.text);
			expect(p.update).toBe(false);
			const edited = p.text.replace('checks', 'checks twice');
			await p.save(edited);
			resolveSkillApproval({ kind: 'saved', edited: true });
		});
		expect(client.draftSkill).toHaveBeenCalledWith(
			{
				update: false,
				name: 'deploy-check',
				description: 'Check a deploy.',
				body: 'Run the checks.',
				project: false
			},
			'/code/repo'
		);
		expect(client.saveSkill.mock.calls[0][1]).toContain('Run the checks twice.');
		expect(result).toContain(
			'Saved the "deploy-check" skill to /data/skills/deploy-check/SKILL.md'
		);
		expect(result).toContain('edited it');
		expect(result).toContain('/deploy-check');
	});

	it('write nothing when the user rejects, and pass on the reason', async () => {
		const result = await runAnswering('update_skill', { name: 'x', body: 'b' }, async () => {
			resolveSkillApproval({ kind: 'rejected', reason: 'too vague' });
		});
		expect(client.draftSkill.mock.calls[0][0]).toMatchObject({ update: true, description: null });
		expect(client.saveSkill).not.toHaveBeenCalled();
		expect(result).toContain('declined');
		expect(result).toContain('too vague');
	});

	it('save to the repo only in Code mode, and count it as a skill the repo had', async () => {
		const args = { ...createArgs, where: 'project' };
		const out = await executeTool('create_skill', args, ctx());
		expect(out.result).toContain('only be saved in Code mode');
		expect(client.draftSkill).not.toHaveBeenCalled();

		await runAnswering(
			'create_skill',
			args,
			async (p) => {
				expect(p.project).toBe(true);
				await p.save(p.text);
				resolveSkillApproval({ kind: 'saved', edited: false });
			},
			ctx({ codeMode: true })
		);
		expect(project.noteProjectSkill).toHaveBeenCalledWith('/code/repo', 'deploy-check');
	});

	it('are refused when called anyway from a job or a remote turn', async () => {
		for (const c of [ctx({ interactive: false }), ctx({ skills: undefined })]) {
			const out = await executeTool('create_skill', createArgs, c);
			expect(out.result).toContain('can only be saved in a conversation');
		}
		expect(client.draftSkill).not.toHaveBeenCalled();
	});

	it('close the prompt when the turn is stopped', async () => {
		const stop = new AbortController();
		const run = executeTool('create_skill', createArgs, ctx({ signal: stop.signal }));
		await vi.waitFor(() => expect(getPendingSkillApproval()).not.toBeNull());
		stop.abort();
		expect((await run).result).toContain('declined');
		expect(getPendingSkillApproval()).toBeNull();
		expect(client.saveSkill).not.toHaveBeenCalled();
	});
});
