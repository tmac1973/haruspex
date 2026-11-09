import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { clip, pivotRig, skinnedLeg, turn } from '#lib/glb/motionFixtures.ts';
import { rigOf, trackNodes } from './rig.ts';

describe('rigOf', () => {
	it('counts a skinned mesh by its skeleton', () => {
		const { root } = skinnedLeg();
		expect(rigOf(root, new Set())).toEqual({ rig: 'skinned', bones: 3 });
	});

	it('counts a rigid rig by the non-mesh nodes its clips move', () => {
		const clips = [
			clip(
				'Wave',
				1,
				turn('Shoulder', [0, 0, 1], [0, 1], [0, 45]),
				turn('Arm', [1, 0, 0], [0, 1], [0, 10])
			)
		];
		expect(rigOf(pivotRig(), trackNodes(THREE, clips))).toEqual({ rig: 'rigid', bones: 1 });
	});
});
