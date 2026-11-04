import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { box, clip, gltf, turn } from './motionFixtures';
import { drawCallsOf, facingOf, unnamedMaterials, worthMerging } from './gameReady';

const scene = (...children: THREE.Object3D[]) => {
	const root = new THREE.Group();
	root.add(...children);
	root.updateMatrixWorld(true);
	return root;
};

describe('drawCallsOf', () => {
	it('counts a call per mesh, and merges still meshes that share a material', () => {
		const steel = new THREE.MeshStandardMaterial({ name: 'steel' });
		const plates = Array.from({ length: 40 }, (_, i) => {
			const m = box(`Plate${i}`, [0.1, 0.1, 0.1], [i * 0.1, 0, 0]);
			m.material = steel;
			return m;
		});
		const d = drawCallsOf(THREE, gltf(scene(...plates), []));
		expect(d).toEqual({ drawCalls: 40, merged: 1 });
		expect(worthMerging(d)).toBe(true);
	});

	it('keeps meshes apart that move apart', () => {
		const steel = new THREE.MeshStandardMaterial();
		const hips = ['Hip_L', 'Hip_R'].map((name) => {
			const pivot = new THREE.Object3D();
			pivot.name = name;
			const leg = box(`${name}_mesh`, [0.1, 0.5, 0.1]);
			leg.material = steel;
			pivot.add(leg);
			return pivot;
		});
		const walk = clip(
			'Walk',
			1,
			turn('Hip_L', [1, 0, 0], [0, 1], [0, 20]),
			turn('Hip_R', [1, 0, 0], [0, 1], [0, -20])
		);
		expect(drawCallsOf(THREE, gltf(scene(...hips), [walk]))).toEqual({ drawCalls: 2, merged: 2 });
	});
});

describe('unnamedMaterials', () => {
	it('counts each material once', () => {
		const plain = new THREE.MeshStandardMaterial();
		const a = box('A', [1, 1, 1]);
		const b = box('B', [1, 1, 1]);
		a.material = plain;
		b.material = plain;
		const c = box('C', [1, 1, 1]);
		(c.material as THREE.Material).name = 'named';
		expect(unnamedMaterials(scene(a, b, c))).toBe(1);
	});
});

describe('facingOf', () => {
	/** A head with eyes on its +z side, and a long tail out behind. */
	const creature = () => {
		const g = new THREE.Group();
		g.add(
			box('Head', [0.3, 0.3, 0.3], [0, 1, 0]),
			box('Eye_L', [0.05, 0.05, 0.05], [0.07, 1.05, 0.15]),
			box('Eye_R', [0.05, 0.05, 0.05], [-0.07, 1.05, 0.15]),
			box('Tail', [0.1, 0.1, 1.5], [0, 0.6, -1])
		);
		return g;
	};
	const size: [number, number, number] = [0.3, 1.15, 1.9];

	it('reads the front from the eyes against the head, not the whole', () => {
		expect(facingOf(THREE, scene(creature()), size)?.faces).toBe('+z');
	});

	it('says a model turned around faces -z', () => {
		const c = creature();
		c.rotation.y = Math.PI;
		expect(facingOf(THREE, scene(c), size)).toEqual({ faces: '-z', parts: ['Eye_L', 'Eye_R'] });
	});

	it('says nothing without parts named for the front', () => {
		expect(facingOf(THREE, scene(box('Crate', [1, 1, 1])), [1, 1, 1])).toBeNull();
	});
});
