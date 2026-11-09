import { describe, expect, it } from 'vitest';
import type { ModelEntry } from '#lib/models3d/spec/types.ts';
import { animateEntryPrompt, animateRepairPrompt } from './prompts';

function entry(clips: ModelEntry['clips']): ModelEntry {
	return {
		id: 'imp',
		title: 'Imp',
		description: 'A small winged imp.',
		height_m: 0.5,
		parts: ['Wing_L'],
		clips,
		dir: 'assets/generated/model/imp/'
	};
}

describe('animate prompts', () => {
	it("hand check_3d the spec's flags its clip names don't imply", () => {
		const e = entry([
			{ name: 'Idle', seconds: 2, loop: true, action: 'breathes' },
			{ name: 'Levitate', seconds: 1, loop: true, airborne: true, action: 'floats' }
		]);
		const arg = 'clips {"Levitate":{"loop":true,"airborne":true}}';
		expect(animateEntryPrompt(e, '')).toContain(arg);
		expect(animateEntryPrompt(e, '')).toContain('- Levitate: 1 s, loops, leaves the floor. floats');
		expect(animateRepairPrompt(e, ['x'])).toContain(arg);
	});

	it('leaves clips out when every clip is what its name says', () => {
		const e = entry([{ name: 'Walk', seconds: 1, loop: true, action: 'walks' }]);
		expect(animateEntryPrompt(e, '')).not.toContain('clips {');
	});
});
