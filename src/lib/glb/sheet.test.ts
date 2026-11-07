import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { CELL, closeUpBounds, framedBounds, sheetLayout } from './sheet';
import type { Bounds } from './report';

const bounds = (min: [number, number, number], max: [number, number, number]): Bounds => ({
	min,
	max,
	size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]]
});

describe('sheetLayout', () => {
	it('lays six labelled cells in a 3 × 2 grid', () => {
		const l = sheetLayout(bounds([-0.5, 0, -0.5], [0.5, 2, 0.5]));
		expect(l.cells.map((c) => [c.label, c.x, c.y])).toEqual([
			['front', 0, 0],
			['right', CELL, 0],
			['back', 2 * CELL, 0],
			['left', 0, CELL],
			['top', CELL, CELL],
			['three-quarter', 2 * CELL, CELL]
		]);
		expect(l.cells[5].half).toBeNull();
	});

	it('frames each orthographic view around the bounds with a margin', () => {
		const l = sheetLayout(bounds([-1, 0, -0.25], [1, 3, 0.25]));
		const [front, right, , , top] = l.cells;
		// front sees x (2) and y (3): half of 3, plus 10 % each side
		expect(front.half).toBeCloseTo(1.5 * 1.2);
		// right sees z (0.5) and y (3)
		expect(right.half).toBeCloseTo(1.5 * 1.2);
		// top sees x (2) and z (0.5)
		expect(top.half).toBeCloseTo(1 * 1.2);
	});

	it('adds 0.1 m grid lines only under 1 m tall', () => {
		expect(sheetLayout(bounds([0, 0, 0], [0.3, 0.5, 0.3])).grid.minor).toBe(0.1);
		expect(sheetLayout(bounds([0, 0, 0], [1, 2, 1])).grid.minor).toBeNull();
		expect(sheetLayout(bounds([0, 0, 0], [1, 2, 1])).grid.major).toBe(1);
	});

	it('stretches the frame to the floor when the asset floats near it', () => {
		expect(framedBounds(bounds([0, 0.5, 0], [1, 1.5, 1])).min[1]).toBe(0);
		expect(framedBounds(bounds([0, 50, 0], [1, 51, 1])).min[1]).toBe(50);
	});
});

describe('closeUpBounds', () => {
	const knight = () => {
		const root = new THREE.Group();
		const body = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.5, 0.3));
		body.name = 'Body';
		body.position.y = 0.75;
		const helm = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3));
		helm.name = 'Helmet';
		helm.position.y = 1.65;
		root.add(body, helm);
		return root;
	};
	const whole = { min: [-0.25, 0, -0.15], max: [0.25, 1.8, 0.15], size: [0.5, 1.8, 0.3] } as Bounds;

	it('frames a named node, and finds a helmet for "head"', () => {
		const r = closeUpBounds(THREE, knight(), 'head', whole);
		expect(r).toMatchObject({ label: 'Helmet' });
		if ('bounds' in r) expect(r.bounds.min[1]).toBeCloseTo(1.5, 5);
		expect(closeUpBounds(THREE, knight(), 'Body', whole)).toMatchObject({ label: 'Body' });
	});

	it('takes the top quarter for "head" when nothing is named like one', () => {
		const root = new THREE.Group();
		root.add(new THREE.Mesh(new THREE.BoxGeometry(1, 2, 1)));
		const r = closeUpBounds(THREE, root, 'head', { ...whole, max: [0.5, 2, 0.5], size: [1, 2, 1] });
		expect(r).toMatchObject({ label: 'the top quarter' });
		if ('bounds' in r) expect(r.bounds.min[1]).toBeCloseTo(1.5, 5);
	});

	it('says when the part is nearly as long as the whole, so it frames like the whole', () => {
		// The 2026-11-04 pine: a trunk running up through the foliage.
		const root = new THREE.Group();
		const trunk = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 4.2));
		trunk.name = 'Trunk';
		trunk.position.y = 2.1;
		const foliage = new THREE.Mesh(new THREE.ConeGeometry(0.86, 3.5));
		foliage.name = 'Foliage';
		foliage.position.y = 2.75;
		root.add(trunk, foliage);
		const tree = {
			min: [-0.86, 0, -0.86],
			max: [0.86, 4.5, 0.86],
			size: [1.72, 4.5, 1.72]
		} as Bounds;
		expect(closeUpBounds(THREE, root, 'Trunk', tree)).toMatchObject({
			label: 'Trunk',
			note: "Trunk is 4.20 m along its longest side, 93% of the whole model's 4.50 m, so the close-up frames nearly all of it. Pass a smaller part, or a pivot around one."
		});
		expect(closeUpBounds(THREE, knight(), 'head', whole)).not.toHaveProperty('note');
	});

	it('names what it cannot find', () => {
		expect(closeUpBounds(THREE, knight(), 'Tail', whole)).toEqual({
			error: 'No node named Tail: pass a mesh or pivot name, or "head".'
		});
	});
});
