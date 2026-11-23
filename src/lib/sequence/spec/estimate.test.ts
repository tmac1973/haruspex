import { describe, it, expect } from 'vitest';
import { estimateRun } from './estimate';
import { planClips } from './plan';
import { LTX, foxSpec } from '#lib/testing/sequenceSpecs.ts';

describe('estimateRun', () => {
	const plan = planClips(foxSpec(), LTX, true);

	it('says the time from the first clip’s pace', () => {
		const e = estimateRun(plan, 260, foxSpec());
		expect(e).toMatchObject({ clips: 25, music: 1, narration: 0, minutes: 108 });
		expect(e.note).toBe("25 clips, 1 music bed: about 108 minutes at the first clip's pace.");
	});

	it('does not guess before a clip is made', () => {
		const e = estimateRun(plan, null, foxSpec());
		expect(e.minutes).toBeNull();
		expect(e.note).toBe(
			'25 clips, 1 music bed. How long it takes is unknown until the first clip is made.'
		);
	});
});
