import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ readSkill: vi.fn(), root: vi.fn() }));
vi.mock('#lib/skills/client.ts', () => ({ readSkill: mocks.readSkill }));
vi.mock('#lib/skills/project.ts', () => ({ knownTrustedRoot: mocks.root }));

import {
	interviewSkillSection,
	loadPlanningSkill,
	outlineRequirementsSection,
	planRequirements,
	verifierRequirements
} from './planningSkill';

const BODY = [
	'# Planning a game',
	'',
	'## Questions',
	'',
	'### Camera',
	'Ask about it.',
	'',
	'## Plan requirements',
	'',
	'- The camera stays in the world.',
	'',
	'## Notes',
	'Not a requirement.'
].join('\n');

describe('planRequirements', () => {
	it('takes the section up to the next heading', () => {
		expect(planRequirements(BODY)).toBe('- The camera stays in the world.');
	});

	it('runs to the end, ignores case, and is null when absent or empty', () => {
		expect(planRequirements('## PLAN REQUIREMENTS\n- a\n- b')).toBe('- a\n- b');
		expect(planRequirements('## Questions\n- a')).toBeNull();
		expect(planRequirements('## Plan requirements\n\n## Next')).toBeNull();
	});
});

describe('prompt sections', () => {
	const skill = { name: 'plan-game', body: BODY };

	it('gives the interview the whole skill', () => {
		const s = interviewSkillSection(skill);
		expect(s).toContain('<skill_content name="plan-game">');
		expect(s).toContain('Ask about it.');
		expect(s).toContain('(from the description)');
	});

	it('gives the outline and verifier only the requirements', () => {
		const s = outlineRequirementsSection(skill);
		expect(s).toContain('The camera stays in the world.');
		expect(s).not.toContain('Ask about it.');
		expect(verifierRequirements(skill)).toBe('- The camera stays in the world.');
		expect(verifierRequirements(null)).toBeNull();
		expect(outlineRequirementsSection({ name: 'x', body: '## Questions\n- a' })).toBe('');
	});
});

describe('loadPlanningSkill', () => {
	it("reads it with the job's trusted repo", async () => {
		mocks.root.mockResolvedValue('/repo');
		mocks.readSkill.mockResolvedValue({ name: 'plan-game', body: BODY });
		expect(await loadPlanningSkill('plan-game', '/repo/src')).toEqual({
			name: 'plan-game',
			body: BODY
		});
		expect(mocks.root).toHaveBeenCalledWith('/repo/src');
		expect(mocks.readSkill).toHaveBeenCalledWith('plan-game', '/repo');
	});

	it('says which skill could not be read, and what to do', async () => {
		mocks.readSkill.mockRejectedValue('no skill named "gone"');
		await expect(loadPlanningSkill('gone', null)).rejects.toThrow(
			/Couldn't read the planning skill "gone": no skill named "gone".*job editor/
		);
	});
});
