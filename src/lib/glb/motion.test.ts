import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clip, gltf, move, pivotRig, skinnedLeg, turn } from './motionFixtures';
import { inspectMotion, sampleTimes } from './motion';

const ROOT_AT = (y: number, x = 0): [number, number, number] => [x, y, 0];

/** The pivot rig with its whole body under a 'Rig' node the clip can move. */
function movable() {
	const inner = pivotRig();
	inner.name = 'Rig';
	const root = new THREE.Group();
	root.add(inner);
	root.updateMatrixWorld(true);
	return root;
}

describe('inspectMotion', () => {
	it('returns nothing for a GLB without clips', () => {
		expect(inspectMotion(THREE, gltf(pivotRig(), []))).toEqual([]);
	});

	it('measures sinking, lifting and drift with their times', () => {
		const root = movable();
		const sink = clip(
			'Sink',
			1,
			move('Rig', [0, 0.5, 1], [ROOT_AT(0), ROOT_AT(-0.03), ROOT_AT(0)])
		);
		const hop = clip('Hop', 1, move('Rig', [0, 0.5, 1], [ROOT_AT(0), ROOT_AT(0.05), ROOT_AT(0)]));
		const slide = clip('Slide', 1, move('Rig', [0, 1], [ROOT_AT(0), ROOT_AT(0, 0.2)]));
		const [s, h, d] = inspectMotion(THREE, gltf(root, [sink, hop, slide]));
		expect(s.sink).toBeCloseTo(0.03, 2);
		expect(s.sinkAt).toBeCloseTo(0.5, 1);
		expect(h.lift).toBeCloseTo(0.05, 2);
		expect(h.sink).toBe(0);
		expect(d.drift).toBeCloseTo(0.2, 2);
	});

	it('measures the loop seam and the part that moves most', () => {
		const root = pivotRig();
		const loop = clip('Loop', 1, turn('Shoulder', [0, 0, 1], [0, 0.5, 1], [0, 60, 0]));
		const stay = clip('Stay', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 60]));
		const [l, s] = inspectMotion(THREE, gltf(root, [loop, stay]));
		expect(l.seam).toBeLessThan(1e-4);
		expect(s.seam).toBeGreaterThan(0.1);
		expect(s.seamPart).toBe('Arm');
		expect(s.fastest).toEqual(['Arm']);
	});

	it('leaves the scene at rest', () => {
		const root = pivotRig();
		const arm = root.getObjectByName('Arm')!;
		const before = arm.getWorldPosition(new THREE.Vector3());
		inspectMotion(THREE, gltf(root, [clip('Up', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 90]))]));
		expect(arm.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-6);
	});

	it('names the rig, and follows a skinned mesh bone by bone', () => {
		const { root } = skinnedLeg();
		const [k] = inspectMotion(
			THREE,
			gltf(root, [clip('Kick', 1, turn('Shin', [1, 0, 0], [0, 1], [0, 90]))])
		);
		expect(k.rig).toBe('skinned');
		expect(k.bones).toBe(3);
		expect(k.seamPart).toBe('Shin');
		const [r] = inspectMotion(
			THREE,
			gltf(pivotRig(), [clip('Up', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 90]))])
		);
		expect(r).toMatchObject({ rig: 'rigid', bones: 1 });
	});
});

describe('sampleTimes', () => {
	it('spans the clip, and gives one frame for a 0 s clip', () => {
		expect(sampleTimes(1, 3)).toEqual([0, 0.5, 1]);
		expect(sampleTimes(0, 16)).toEqual([0]);
	});
});
