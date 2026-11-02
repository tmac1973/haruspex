import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { normaliseGlb } from './normalise';

function asset() {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1), new THREE.MeshStandardMaterial());
	mesh.name = 'Body';
	mesh.position.set(3, 5, -1);
	const root = new THREE.Group();
	root.add(mesh);
	const clip = new THREE.AnimationClip('Bob', 1, [
		new THREE.NumberKeyframeTrack('Body.position[y]', [0, 1], [5, 5.2])
	]);
	return { scene: root, animations: [clip] };
}

async function reload(bytes: Uint8Array) {
	const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
	return new GLTFLoader().parseAsync(buf as ArrayBuffer, '');
}

describe('normaliseGlb', () => {
	it('scales to a height, grounds and centres, and keeps clips', async () => {
		const out = await normaliseGlb(THREE, asset(), { height: 1, ground: true });
		if ('error' in out) throw new Error(out.error);
		expect(out.before.size.map((n) => +n.toFixed(3))).toEqual([1, 2, 1]);
		expect(out.before.min[1]).toBeCloseTo(4);
		expect(out.after.size[1]).toBeCloseTo(1);
		expect(out.after.min[1]).toBeCloseTo(0);
		expect((out.after.min[0] + out.after.max[0]) / 2).toBeCloseTo(0);
		expect((out.after.min[2] + out.after.max[2]) / 2).toBeCloseTo(0);

		const back = await reload(out.bytes);
		const box = new THREE.Box3().setFromObject(back.scene);
		expect(box.min.y).toBeCloseTo(0);
		expect(box.max.y).toBeCloseTo(1);
		expect(back.animations.map((a) => a.name)).toEqual(['Bob']);
	});

	it('grounds without scaling when only ground is given', async () => {
		const out = await normaliseGlb(THREE, asset(), { ground: true });
		if ('error' in out) throw new Error(out.error);
		expect(out.after.size[1]).toBeCloseTo(2);
		expect(out.after.min[1]).toBeCloseTo(0);
	});

	it('refuses a height that is not a positive number', async () => {
		expect(await normaliseGlb(THREE, asset(), { height: 0 })).toEqual({
			error: 'height must be a number of metres above 0.'
		});
	});
});
