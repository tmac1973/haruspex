import { describe, expect, it } from 'vitest';
import { HUMANOID_PARTS, QUADRUPED_PARTS, RIG_PARTS_LINES } from './rigs';
import { PART_PATTERN } from './types';

describe('the planner rigs', () => {
	it('name every part as a pivot may be named, once', () => {
		for (const parts of [HUMANOID_PARTS, QUADRUPED_PARTS]) {
			expect(parts.every((p) => PART_PATTERN.test(p))).toBe(true);
			expect(new Set(parts).size).toBe(parts.length);
		}
	});

	it('give the hips, ankles and wrists a pivot each', () => {
		expect(HUMANOID_PARTS).toEqual(
			expect.arrayContaining(['Pelvis', 'Foot_L', 'Foot_R', 'Hand_L', 'Hand_R'])
		);
		expect(QUADRUPED_PARTS).toEqual(
			expect.arrayContaining(['Pelvis', 'Foot_FL', 'Foot_FR', 'Foot_HL', 'Foot_HR'])
		);
	});

	it('put both lists in the prompt lines', () => {
		const text = RIG_PARTS_LINES.join('\n');
		for (const p of [...HUMANOID_PARTS, ...QUADRUPED_PARTS]) expect(text).toContain(p);
	});
});
