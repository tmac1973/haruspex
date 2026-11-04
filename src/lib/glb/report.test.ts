import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { inspectGlb, meshShape } from './report';

function box(name: string, size = 1, at: [number, number, number] = [0, 0, 0]): THREE.Mesh {
	const mesh = new THREE.Mesh(
		new THREE.BoxGeometry(size, size, size),
		new THREE.MeshStandardMaterial({ name: `${name}Mat` })
	);
	mesh.name = name;
	mesh.position.set(...at);
	return mesh;
}

function scene(...children: THREE.Object3D[]): THREE.Group {
	const g = new THREE.Group();
	g.add(...children);
	return g;
}

const inspect = (root: THREE.Object3D, clips: THREE.AnimationClip[] = [], max?: number) =>
	inspectGlb(THREE, { scene: root, animations: clips }, { maxTriangles: max });

describe('inspectGlb', () => {
	it('measures size, feet, centre offset, counts and clips', () => {
		const clip = new THREE.AnimationClip('Bob', 2, [
			new THREE.NumberKeyframeTrack('a.position[y]', [0, 2], [0, 1])
		]);
		const r = inspect(scene(box('a', 2, [1, 1, 0]), box('b', 1, [1, 2.5, 0])), [clip]);
		expect(r.bounds.size.map((n) => +n.toFixed(3))).toEqual([2, 3, 2]);
		expect(r.feetY).toBeCloseTo(0);
		expect(r.height).toBeCloseTo(3);
		expect(r.centreOffset.map((n) => +n.toFixed(3))).toEqual([1, 0]);
		expect(r.meshes).toBe(2);
		expect(r.triangles).toBe(24);
		expect(r.animations).toEqual([{ name: 'Bob', duration: 2, tracks: 1 }]);
		expect(r.problems).toEqual([]);
		expect(r.floating).toEqual([]);
	});

	it('finds a part that touches nothing', () => {
		const r = inspect(scene(box('a'), box('b', 1, [1, 0, 0]), box('c', 1, [4, 0, 0])));
		expect(r.floating).toEqual(['c']);
	});

	it('finds a part buried inside another, and names the host', () => {
		const r = inspect(scene(box('big', 2), box('small', 0.5)));
		expect(r.buried).toEqual([{ part: 'small', inside: 'big' }]);
	});

	it('does not call a part buried when it pokes out of its host', () => {
		const head = new THREE.Mesh(
			new THREE.SphereGeometry(1, 16, 12),
			new THREE.MeshStandardMaterial()
		);
		head.name = 'Head';
		const eye = new THREE.Mesh(
			new THREE.SphereGeometry(0.2, 8, 6),
			new THREE.MeshStandardMaterial()
		);
		eye.name = 'Eye';
		eye.position.set(0.3, 0.2, 0.9);
		expect(inspect(scene(head, eye)).buried).toEqual([]);
	});

	it('does not call a part buried inside a transparent host', () => {
		const glass = box('Glass', 2);
		(glass.material as THREE.Material).transparent = true;
		expect(inspect(scene(glass, box('Liquid', 1))).buried).toEqual([]);
	});

	it('flags tiny parts as outliers', () => {
		const r = inspect(scene(box('body', 2), box('speck', 0.005, [1, 0, 0])));
		expect(r.outliers).toEqual(['speck']);
	});

	it('warns about an open one-sided mesh, not a double-sided one', () => {
		const plane = (side: THREE.Side, name: string) => {
			const m = new THREE.Mesh(
				new THREE.PlaneGeometry(1, 1),
				new THREE.MeshBasicMaterial({ side })
			);
			m.name = name;
			return m;
		};
		const one = inspect(scene(plane(THREE.FrontSide, 'wing')));
		expect(one.warnings.join(' ')).toContain("'wing' is one-sided and open");
		const two = inspect(scene(plane(THREE.DoubleSide, 'wing')));
		expect(two.warnings.join(' ')).not.toContain('one-sided');
	});

	it('treats a box split at its UV seams as closed', () => {
		// BoxGeometry has 24 vertices (split per face); welded, it is closed.
		expect(meshShape(new THREE.BoxGeometry(1, 1, 1), 1e-5)).toMatchObject({ boundary: 0 });
		expect(meshShape(new THREE.BoxGeometry(1, 1, 1), 1e-5).volume).toBeCloseTo(1);
	});

	it('warns about a closed mesh whose faces point inward', () => {
		const geo = new THREE.BoxGeometry(1, 1, 1);
		const idx = Array.from(geo.index!.array);
		for (let i = 0; i < idx.length; i += 3) [idx[i + 1], idx[i + 2]] = [idx[i + 2], idx[i + 1]];
		geo.setIndex(idx);
		const inside = new THREE.Mesh(geo, new THREE.MeshStandardMaterial());
		inside.name = 'crate';
		expect(inspect(scene(inside)).warnings).toContain("'crate' has its faces pointing inward.");
		expect(inspect(scene(box('ok'))).warnings).toEqual([]);
	});

	it('does not call a mirrored closed mesh inward', () => {
		const m = box('mirror');
		m.scale.set(-1, 1, 1);
		expect(inspect(scene(m)).warnings).toEqual([]);
	});

	it('warns about missing normals', () => {
		const m = box('flat');
		m.geometry.deleteAttribute('normal');
		expect(inspect(scene(m)).warnings).toContain("'flat' has no normals.");
	});

	it('fails on NaN positions, no meshes or zero size', () => {
		const bad = box('rock');
		(bad.geometry.getAttribute('position').array as Float32Array)[4] = NaN;
		expect(inspect(scene(box('ok'), bad)).problems).toContain(
			"Mesh 'rock' has NaN vertex positions."
		);
		expect(inspect(new THREE.Group()).problems).toEqual([
			'The GLB has no meshes.',
			'The GLB has zero or non-finite size.'
		]);
		expect(inspect(scene(box('dot', 0))).problems).toEqual([
			'The GLB has zero or non-finite size.'
		]);
	});

	it('warns when the height is off the spec by over 10%, and about unnamed materials', () => {
		const tall = scene(box('a', 2, [0, 1, 0]));
		expect(
			inspectGlb(THREE, { scene: tall, animations: [] }, { specHeight: 2.1 }).warnings
		).toEqual([]);
		expect(
			inspectGlb(THREE, { scene: tall, animations: [] }, { specHeight: 1.5 }).warnings
		).toContain(
			'Height is 2.00 m; the spec says 1.50 m (±10%). Pass height to scale it, or rebuild it to size.'
		);
		const plain = box('b');
		(plain.material as THREE.Material).name = '';
		expect(inspect(scene(plain)).warnings).toContain(
			'1 material has no name: name each, since engines list materials by name.'
		);
		expect(inspect(scene(plain)).drawCalls).toBe(1);
	});

	it('warns over a triangle budget only when one is given', () => {
		expect(inspect(scene(box('a')), [], 10).warnings).toContain(
			'12 triangles is over the budget of 10.'
		);
		expect(inspect(scene(box('a'))).warnings).toEqual([]);
	});

	it('lists materials once and the heaviest parts first', () => {
		const shared = new THREE.MeshStandardMaterial({ name: 'Red', color: 0xff0000 });
		const a = new THREE.Mesh(new THREE.SphereGeometry(1, 8, 6), shared);
		a.name = 'Ball';
		const b = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), shared);
		b.name = 'Cube';
		b.position.x = 1;
		const r = inspect(scene(a, b));
		expect(r.materials).toEqual([
			expect.objectContaining({ name: 'Red', type: 'Standard', color: '#ff0000' })
		]);
		expect(r.heaviest[0].name).toBe('Ball');
	});
});
