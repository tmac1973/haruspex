import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SkillDoc } from '#lib/ipc/gen/SkillDoc.ts';

const client = vi.hoisted(() => ({ readSkillForTurn: vi.fn() }));
vi.mock('#lib/skills/client.ts', () => client);

import { gateNote, skillGate } from './_skillGate';
import { coveredTools } from '#lib/agent/loop/context.ts';
import type { ToolContext } from './types';

const doc: SkillDoc = {
	name: 'fix-picture',
	body: 'Pick edit, area, extend or upscale.',
	dir: null,
	compatibility: null,
	files: [],
	filesTruncated: false,
	needs: ['image']
};

function ctx(loaded: string[] = [], names = ['fix-picture']): ToolContext {
	return {
		skills: {
			names,
			readable: names,
			projectRoot: null,
			loaded: new Set(loaded),
			covers: coveredTools([
				{ name: 'fix-picture', description: '', tools: ['edit_image', 'upscale_image'] }
			])
		}
	} as unknown as ToolContext;
}

beforeEach(() => client.readSkillForTurn.mockReset().mockResolvedValue(doc));

describe('skillGate', () => {
	it('returns the skill in place of the first covered call', async () => {
		const c = ctx();
		const out = await skillGate('edit_image', c);
		expect(out?.result).toContain('<skill_content name="fix-picture">');
		expect(out?.result).toContain('Pick edit, area, extend or upscale.');
		expect(out?.result).toContain(gateNote('edit_image', 'fix-picture'));
		expect(c.skills!.loaded.has('fix-picture')).toBe(true);
		// The second call runs.
		expect(await skillGate('upscale_image', c)).toBeNull();
		expect(client.readSkillForTurn).toHaveBeenCalledTimes(1);
	});

	it('lets the call run when the skill is loaded, not covering, or not offered', async () => {
		expect(await skillGate('edit_image', ctx(['fix-picture']))).toBeNull();
		expect(await skillGate('generate_image', ctx())).toBeNull();
		expect(await skillGate('edit_image', ctx([], []))).toBeNull();
		expect(await skillGate('edit_image', {} as ToolContext)).toBeNull();
		expect(client.readSkillForTurn).not.toHaveBeenCalled();
	});

	it('lets the call run when the skill cannot be read', async () => {
		client.readSkillForTurn.mockRejectedValue(new Error('gone'));
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
		expect(await skillGate('edit_image', ctx())).toBeNull();
		expect(warn).toHaveBeenCalled();
	});
});

describe('coveredTools', () => {
	it('gives each tool to the first skill that names it', () => {
		const covers = coveredTools([
			{ name: 'a', description: '', tools: ['edit_image'] },
			{ name: 'b', description: '', tools: ['edit_image', 'upscale_image'] }
		]);
		expect(covers.get('edit_image')).toBe('a');
		expect(covers.get('upscale_image')).toBe('b');
	});
});
