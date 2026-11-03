import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { box, clip, pivotRig, skinnedLeg, turn } from './motionFixtures';
import { partCentre, partsOf, posedBox, poser, strideFor } from './motionPose';

const worldOf = (o: THREE.Object3D) => o.getWorldPosition(new THREE.Vector3());

describe('poser', () => {
	it('holds the last pose at the end and restores the rest pose on stop', () => {
		const root = pivotRig();
		const arm = root.getObjectByName('Arm')!;
		const rest = worldOf(arm).clone();
		const pose = poser(THREE, root, clip('Raise', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 90])));
		pose.at(1);
		const up = worldOf(arm);
		expect(up.x).toBeCloseTo(0.2);
		expect(up.y).toBeCloseTo(1.15);
		pose.at(0);
		expect(worldOf(arm).distanceTo(rest)).toBeLessThan(1e-6);
		pose.at(1);
		pose.stop();
		expect(worldOf(arm).distanceTo(rest)).toBeLessThan(1e-6);
	});
});

describe('skinned meshes', () => {
	it('reads posed vertices through the skeleton', () => {
		const { root, mesh } = skinnedLeg();
		const rest = posedBox(THREE, [mesh], 1);
		const pose = poser(THREE, root, clip('Kick', 1, turn('Shin', [1, 0, 0], [0, 1], [0, 90])));
		pose.at(1);
		const bent = posedBox(THREE, [mesh], 1);
		expect(rest.max.y).toBeCloseTo(2);
		expect(bent.max.y).toBeLessThan(1.2);
		expect(bent.max.z).toBeGreaterThan(0.9);
		pose.stop();
	});

	it('splits a skinned mesh into one part per bone', () => {
		const { root } = skinnedLeg();
		const parts = partsOf(root);
		expect(parts.map((p) => p.name).sort()).toEqual(['Shin', 'Thigh']);
		const shin = parts.find((p) => p.name === 'Shin')!;
		expect(partCentre(THREE, shin, 1).y).toBeGreaterThan(1);
	});
});

describe('partsOf', () => {
	it('makes repeated names unique in traversal order', () => {
		const root = new THREE.Group();
		root.add(box('Leg', [1, 1, 1]), box('Leg', [1, 1, 1]), box('Arm', [1, 1, 1]));
		expect(partsOf(root).map((p) => p.name)).toEqual(['Leg', 'Leg #2', 'Arm']);
	});
});

describe('strideFor', () => {
	it('reads every vertex of a small asset and thins a big one', () => {
		const small = box('a', [1, 1, 1]);
		expect(strideFor([small])).toBe(1);
		const big = new THREE.Mesh(new THREE.SphereGeometry(1, 200, 200));
		expect(strideFor([big])).toBeGreaterThan(1);
	});
});
