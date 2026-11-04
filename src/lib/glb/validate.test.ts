import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { glbNames, groupIssues, subject, validateGlb } from './validate';

/** A box whose vertex colours go past 1, exported without the runner's clamp. */
async function brightBox(): Promise<Uint8Array> {
	const geo = new THREE.BoxGeometry(1, 1, 1);
	const colours = new Float32Array(geo.attributes.position.count * 3).fill(1.2);
	geo.setAttribute('color', new THREE.BufferAttribute(colours, 3));
	const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ vertexColors: true }));
	mesh.name = 'Breastplate';
	const group = new THREE.Group();
	group.add(mesh);
	const out = await new GLTFExporter().parseAsync(group, { binary: true });
	return new Uint8Array(out as ArrayBuffer);
}

const names = {
	meshes: ['Helmet', 'Breastplate'],
	nodes: ['Root', 'Hip_L'],
	clips: [{ name: 'Walk', samplerNode: new Map([[3, 'Hip_L']]) }]
};

describe('subject', () => {
	it('names the mesh, node or clip track a pointer points at', () => {
		expect(subject('/meshes/1/primitives/0/attributes/COLOR_0', names)).toBe('Breastplate');
		expect(subject('/nodes/1', names)).toBe('Hip_L');
		expect(subject('/animations/0/samplers/3/output', names)).toBe('Walk (Hip_L)');
		expect(subject('/animations/0', names)).toBe('Walk');
		expect(subject('/skins/0/joints', names)).toBe('skin 0');
		expect(subject('/accessors/4', names)).toBeNull();
		expect(subject(undefined, names)).toBeNull();
	});
});

describe('groupIssues', () => {
	const colour = (i: number, mesh: number) => ({
		code: 'ACCESSOR_NON_CLAMPED',
		message: `Accessor element at index ${i} is not clamped to 0..1 range: 1.05.`,
		severity: 0,
		pointer: `/meshes/${mesh}/primitives/0/attributes/COLOR_0`
	});

	it('gives one line per kind, counted, naming where, with the fix', () => {
		const lines = groupIssues([colour(1, 0), colour(2, 0), colour(3, 1)], names);
		expect(lines).toEqual([
			'- Vertex colour values outside 0–1 ×3 in Helmet, Breastplate: keep colours within 0–1.'
		]);
	});

	it('keeps errors and the warnings that matter, and drops the rest', () => {
		const lines = groupIssues(
			[
				{
					code: 'NODE_SKINNED_MESH_NON_ROOT',
					message: 'not root',
					severity: 1,
					pointer: '/nodes/1'
				},
				{ code: 'UNUSED_OBJECT', message: 'unused', severity: 2 },
				{
					code: 'ANIMATION_CHANNEL_TARGET_NODE_SKIN',
					message: 'x',
					severity: 1,
					pointer: '/animations/0/channels/3'
				}
			],
			names
		);
		expect(lines).toEqual([
			'- Tracks on a skinned mesh’s own node (they do nothing) ×1 in Walk (Hip_L): animate the bones instead.'
		]);
	});

	it('quotes the validator for a kind it has no plain words for, and cuts long lists', () => {
		const odd = (code: string) => ({ code, message: `${code} happened.`, severity: 0 });
		const lines = groupIssues(['A', 'B', 'C', 'D', 'E', 'F', 'G'].map(odd), names);
		expect(lines[0]).toBe('- A ×1: A happened.');
		expect(lines).toHaveLength(7);
		expect(lines[6]).toBe('- and 1 more kinds of issue.');
	});
});

describe('validateGlb', () => {
	it('finds colours past 1 that three draws without complaint', async () => {
		const bytes = await brightBox();
		expect(glbNames(bytes).meshes).toEqual(['Breastplate']);
		const v = await validateGlb(bytes);
		expect(v.errors).toBe(72);
		expect(v.lines).toEqual([
			'- Vertex colour values outside 0–1 ×72 in Breastplate: keep colours within 0–1.'
		]);
	});

	it('has nothing to say about a clean GLB', async () => {
		const out = await new GLTFExporter().parseAsync(
			new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()),
			{ binary: true }
		);
		expect(await validateGlb(new Uint8Array(out as ArrayBuffer))).toEqual({ errors: 0, lines: [] });
	});
});
