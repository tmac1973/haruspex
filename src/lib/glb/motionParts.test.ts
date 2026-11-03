import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { box, clip, gltf, move, skinnedLeg, turn } from './motionFixtures';
import { inspectMotion } from './motion';
import { formatClip } from './motionFormat';
import { foldDegrees, jointsOf } from './motionParts';

const scene = (...children: THREE.Object3D[]) => {
	const root = new THREE.Group();
	root.add(...children);
	root.updateMatrixWorld(true);
	return root;
};
const one = (root: THREE.Object3D, ...tracks: THREE.KeyframeTrack[]) =>
	inspectMotion(THREE, gltf(root, [clip('Clip', 1, ...tracks)]))[0];
const body = () => box('Body', [0.4, 1, 0.4], [0, 0.5, 0]);

describe('passing into', () => {
	it('reports a part that moves into a closed body, with its times', () => {
		const fist = box('Fist', [0.1, 0.1, 0.1], [0.6, 0.5, 0]);
		const c = one(
			scene(body(), fist),
			move(
				'Fist',
				[0, 0.5, 1],
				[
					[0.6, 0.5, 0],
					[0, 0.5, 0],
					[0.6, 0.5, 0]
				]
			)
		);
		expect(c.passes).toHaveLength(1);
		expect(c.passes[0]).toMatchObject({ part: 'Fist', into: 'Body' });
		expect(c.passes[0].from).toBeGreaterThan(0.2);
		expect(c.passes[0].to).toBeLessThan(0.8);
	});

	it('leaves a joint that overlaps at rest alone', () => {
		const stub = box('Stub', [0.2, 0.1, 0.1], [0.2, 0.5, 0]);
		const c = one(
			scene(body(), stub),
			move(
				'Stub',
				[0, 1],
				[
					[0.2, 0.5, 0],
					[0.15, 0.5, 0]
				]
			)
		);
		expect(c.passes).toEqual([]);
	});

	it('never counts a see-through part as a host', () => {
		const glass = body();
		(glass.material as THREE.Material).transparent = true;
		const fist = box('Fist', [0.1, 0.1, 0.1], [0.6, 0.5, 0]);
		const c = one(
			scene(glass, fist),
			move(
				'Fist',
				[0, 1],
				[
					[0.6, 0.5, 0],
					[0, 0.5, 0]
				]
			)
		);
		expect(c.passes).toEqual([]);
	});
});

describe('coming apart', () => {
	it('reports a part left behind when the body moves away', () => {
		const spike = box('Spike', [0.1, 0.1, 0.1], [0.25, 0.5, 0]);
		const b = body();
		b.add(box('Head', [0.2, 0.2, 0.2], [0, 0.6, 0]));
		const c = one(
			scene(b, spike),
			move(
				'Body',
				[0, 1],
				[
					[0, 0.5, 0],
					[-1, 0.5, 0]
				]
			)
		);
		expect(c.apart.map((a) => a.part)).toEqual(['Spike']);
	});

	it('keeps a part that moves with the body, even when hidden behind it', () => {
		const b = body();
		const claw = box('Claw', [0.1, 0.1, 0.1], [0.05, 0, -0.25]);
		b.add(claw);
		const c = one(
			scene(b),
			move(
				'Body',
				[0, 1],
				[
					[0, 0.5, 0],
					[-1, 0.5, 0]
				]
			)
		);
		expect(c.apart).toEqual([]);
	});
});

describe('foot slide', () => {
	const foot = () => box('Foot', [0.1, 0.1, 0.2], [0, 0.05, 0]);

	it('reports a planted foot sliding', () => {
		const c = one(
			scene(foot()),
			move(
				'Foot',
				[0, 1],
				[
					[0, 0.05, 0],
					[0.1, 0.05, 0]
				]
			)
		);
		expect(c.slides).toHaveLength(1);
		expect(c.slides[0].part).toBe('Foot');
		expect(c.slides[0].cm).toBeGreaterThanOrEqual(9);
		expect(c.slides[0].cm).toBeLessThanOrEqual(11);
	});

	it('leaves a step alone: lift, move, land', () => {
		const step = move(
			'Foot',
			[0, 0.3, 0.7, 1],
			[
				[0, 0.05, 0],
				[0, 0.25, 0],
				[0.1, 0.25, 0],
				[0.1, 0.05, 0]
			]
		);
		expect(one(scene(foot()), step).slides).toEqual([]);
	});
});

/** Hips → Thigh_L → Shin_L → Foot_L, a leg hanging straight down from y = 1. */
function leg(lower = 'Shin_L') {
	const node = (name: string, y: number) => {
		const o = new THREE.Object3D();
		o.name = name;
		o.position.y = y;
		return o;
	};
	const hips = node('Hips', 1);
	const thigh = node('Thigh_L', 0);
	const shin = node(lower, -0.5);
	const foot = node('Foot_L', -0.5);
	shin.add(foot, box(`Mesh_${lower}`, [0.1, 0.5, 0.1], [0, -0.25, 0]));
	thigh.add(shin, box('Mesh_Thigh_L', [0.1, 0.5, 0.1], [0, -0.25, 0]));
	hips.add(thigh);
	return scene(hips);
}

describe('joint folds', () => {
	it('finds knees and elbows by name, never meshes', () => {
		expect(jointsOf(leg()).map((j) => j.node.name)).toEqual(['Shin_L']);
		expect(jointsOf(leg('Forearm_L')).map((j) => j.sign)).toEqual([-1]);
	});

	it('measures a backward fold as positive', () => {
		const root = leg();
		root.getObjectByName('Shin_L')!.rotation.x = Math.PI / 6;
		root.updateMatrixWorld(true);
		expect(foldDegrees(THREE, jointsOf(root)[0])).toBeCloseTo(30, 0);
	});

	it('reports a knee bending forward and leaves one bending back alone', () => {
		const back = one(leg(), turn('Shin_L', [1, 0, 0], [0, 1], [0, 30]));
		expect(back.joints).toEqual([]);
		expect(back.jointsChecked).toEqual(['Shin_L']);
		const forward = one(leg(), turn('Shin_L', [1, 0, 0], [0, 1], [0, -30]));
		expect(forward.joints).toHaveLength(1);
		expect(forward.joints[0].joint).toBe('Shin_L');
		expect(forward.joints[0].degrees).toBeCloseTo(30, -1);
	});

	it('reports an elbow bending backward', () => {
		const c = one(leg('Forearm_L'), turn('Forearm_L', [1, 0, 0], [0, 1], [0, 30]));
		expect(c.joints.map((j) => j.joint)).toEqual(['Forearm_L']);
	});

	it('checks a skinned leg through its bones, and lists the joints', () => {
		const { root } = skinnedLeg();
		const c = one(root, turn('Shin', [1, 0, 0], [0, 1], [0, -45]));
		expect(c.jointsChecked).toEqual(['Shin']);
		expect(c.joints.map((j) => j.joint)).toEqual(['Shin']);
		expect(formatClip(c, false)).toContain('Joints checked: Shin.');
	});

	it('says when it found no joints by name', () => {
		const c = one(
			scene(body()),
			move(
				'Body',
				[0, 1],
				[
					[0, 0.5, 0],
					[0, 0.6, 0]
				]
			)
		);
		expect(formatClip(c, false)).toContain('No knee or elbow joints found by name.');
	});
});
