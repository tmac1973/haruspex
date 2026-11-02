import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { formatReport, MAX_REPORT_CHARS } from './format';
import { inspectGlb } from './report';

const skin = new THREE.MeshStandardMaterial({ name: 'Skin', color: 0xa62821 });

function box(name: string, x: number): THREE.Mesh {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), skin);
	mesh.name = name;
	mesh.position.set(x, 0.5, 0);
	return mesh;
}

describe('formatReport', () => {
	it('says size, parts, floating parts, materials and clips', () => {
		const g = new THREE.Group();
		g.add(box('Body', 0), box('Hat', 5));
		const clip = new THREE.AnimationClip('Idle', 2, [
			new THREE.NumberKeyframeTrack('Body.position[y]', [0, 2], [0.5, 0.6])
		]);
		const text = formatReport(inspectGlb(THREE, { scene: g, animations: [clip] }), {
			normalisedFrom: { min: [0, 0, 0], max: [2, 4, 2], size: [2, 4, 2] }
		});
		expect(text).toBe(
			[
				'Size: 6.00 × 1.00 × 1.00 m (x × y × z). Feet at y = 0.00; centre offset x 2.50, z 0.00. Normalised from 2.00 × 4.00 × 2.00 m.',
				'2 meshes, 24 triangles. Heaviest: Body 12, Hat 12.',
				'Floating (touch nothing): Body, Hat.',
				'Materials: Skin (Standard, #a62821).',
				'Animations: Idle 2.0 s (1 track).'
			].join('\n')
		);
	});

	it('stays short for a big asset', () => {
		const g = new THREE.Group();
		for (let i = 0; i < 60; i++) {
			// Open one-sided planes: one warning each.
			const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial());
			m.name = `Membrane_With_A_Long_Name_${i}`;
			m.position.x = i;
			g.add(m);
		}
		const text = formatReport(inspectGlb(THREE, { scene: g, animations: [] }));
		expect(text.length).toBeLessThanOrEqual(MAX_REPORT_CHARS);
		expect(text).toMatch(/and \d+ more warnings/);
	});
});
