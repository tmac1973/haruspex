import { describe, it, expect } from 'vitest';
import { modelsNote, planModelSpecPrompt } from './pipeline';

describe('planModelSpecPrompt', () => {
	it('asks for the plan’s own ids and names the tool and the file', () => {
		const p = planModelSpecPrompt('plan/game/', 'plan/game/models.json');
		expect(p).toContain('copied');
		expect(p).toContain('`submit_plan_model_spec`');
		expect(p).toContain('`plan/game/models.json`');
	});
});

describe('modelsNote', () => {
	it('says where each model will be, and that code loads it', () => {
		const note = modelsNote();
		expect(note).toContain('assets/generated/model/<id>/<id>.glb');
		expect(note).toContain('code loads them, it does not build them');
	});
});
