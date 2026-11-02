import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';

const loaded = vi.hoisted(() => ({
	result: null as { scene: unknown; animations: unknown[] } | Error | null
}));
const renders = vi.hoisted(() => ({ count: 0, disposed: 0 }));

vi.mock('three/examples/jsm/loaders/GLTFLoader.js', () => ({
	GLTFLoader: class {
		async parseAsync() {
			if (loaded.result instanceof Error) throw loaded.result;
			return loaded.result;
		}
	}
}));

vi.mock('three', async (importOriginal) => ({
	...(await importOriginal<typeof import('three')>()),
	WebGLRenderer: class {
		setSize() {}
		render() {
			renders.count++;
		}
		dispose() {
			renders.disposed++;
		}
	}
}));

import { previewGlb } from './preview';

function box(name: string, size = 1): THREE.Mesh {
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(size, size, size),
		new THREE.MeshStandardMaterial()
	);
	mesh.name = name;
	return mesh;
}

function load(scene: THREE.Object3D, animations: THREE.AnimationClip[] = []) {
	loaded.result = { scene, animations };
}

const BYTES = new Uint8Array([103, 108, 84, 70]);

beforeEach(() => {
	renders.count = 0;
	renders.disposed = 0;
	vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,X');
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe('previewGlb', () => {
	it('counts meshes, triangles, animations and size, and renders', async () => {
		const scene = new THREE.Group();
		scene.add(box('body', 2));
		const head = box('head');
		head.position.set(0, 1.5, 0);
		scene.add(head);
		const plane = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).toNonIndexed());
		scene.add(plane);
		const walk = new THREE.AnimationClip('Walk', 1, [
			new THREE.NumberKeyframeTrack('head.position[y]', [0, 1], [1.5, 1.6]),
			new THREE.NumberKeyframeTrack('body.position[y]', [0, 1], [0, 0.1])
		]);
		load(scene, [walk]);

		const p = await previewGlb(BYTES);
		expect(p.ok).toBe(true);
		expect(p.problems).toEqual([]);
		expect(p.meshes).toBe(3);
		expect(p.triangles).toBe(12 + 12 + 2);
		expect(p.animations).toEqual([{ name: 'Walk', tracks: 2 }]);
		expect(p.size.map((n) => +n.toFixed(3))).toEqual([2, 3, 2]);
		expect(p.png).toBe('data:image/png;base64,X');
		expect(renders).toEqual({ count: 1, disposed: 1 });
	});

	it('flags NaN vertex positions', async () => {
		const bad = box('rock');
		(bad.geometry.getAttribute('position').array as Float32Array)[4] = NaN;
		const scene = new THREE.Group();
		scene.add(box('ok'), bad);
		load(scene);
		const p = await previewGlb(BYTES);
		expect(p.ok).toBe(false);
		expect(p.problems).toContain("Mesh 'rock' has NaN vertex positions.");
	});

	it('flags a GLB with no meshes, and so no size', async () => {
		load(new THREE.Group());
		const p = await previewGlb(BYTES);
		expect(p.meshes).toBe(0);
		expect(p.problems).toEqual(['The GLB has no meshes.', 'The GLB has zero or non-finite size.']);
	});

	it('flags a zero size', async () => {
		const scene = new THREE.Group();
		scene.add(box('dot', 0));
		load(scene);
		const p = await previewGlb(BYTES);
		expect(p.problems).toEqual(['The GLB has zero or non-finite size.']);
	});

	it('reports a parse error with no PNG', async () => {
		loaded.result = new Error('Unexpected token');
		const p = await previewGlb(BYTES);
		expect(p).toMatchObject({ ok: false, png: null, meshes: 0 });
		expect(p.problems).toEqual(['The GLB did not load: Unexpected token']);
		expect(renders.count).toBe(0);
	});
});
