import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { checkGlb } from './check';

async function glbOf(...meshes: THREE.Mesh[]): Promise<Uint8Array> {
	return glbWith([], ...meshes);
}

async function glbWith(clips: THREE.AnimationClip[], ...meshes: THREE.Mesh[]) {
	const root = new THREE.Group();
	root.add(...meshes);
	const out = await new GLTFExporter().parseAsync(root, { binary: true, animations: clips });
	return new Uint8Array(out as ArrayBuffer);
}

const bob = (name: string, node: string) =>
	new THREE.AnimationClip(name, 1, [
		new THREE.VectorKeyframeTrack(`${node}.position`, [0, 0.5, 1], [0, 3, 0, 0, 3.2, 0, 0, 3, 0])
	]);

function box(name: string, h = 2): THREE.Mesh {
	const m = new THREE.Mesh(new THREE.BoxGeometry(1, h, 1), new THREE.MeshStandardMaterial());
	m.name = name;
	m.position.y = 3;
	return m;
}

beforeEach(() => {
	// jsdom has no WebGL: the sheet can't draw, and says so.
	vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('checkGlb', () => {
	it('reports a GLB as it is', async () => {
		const bytes = await glbOf(box('Crate'));
		const c = await checkGlb(bytes);
		if ('problems' in c) throw new Error(c.problems.join());
		expect(c.bytes).toBe(bytes);
		expect(c.report.feetY).toBeCloseTo(2);
		expect(c.text).toContain('Size: 1.00 × 2.00 × 1.00 m');
		expect(c.png).toBeNull();
		expect(c.normalisedFrom).toBeUndefined();
	});

	it('normalises, and reports what it will write', async () => {
		const c = await checkGlb(await glbOf(box('Crate')), { height: 1, ground: true });
		if ('problems' in c) throw new Error(c.problems.join());
		expect(c.report.height).toBeCloseTo(1);
		expect(c.report.feetY).toBeCloseTo(0);
		expect(c.normalisedFrom?.size[1]).toBeCloseTo(2);
		expect(c.text).toContain('Normalised from 1.00 × 2.00 × 1.00 m.');
	});

	it('fails on bytes that are not a GLB', async () => {
		const c = await checkGlb(new Uint8Array([1, 2, 3, 4]));
		expect('problems' in c && c.problems[0]).toMatch(/^The GLB did not load:/);
	});

	it('fails on a GLB with no meshes, before normalising', async () => {
		const empty = new Uint8Array(
			(await new GLTFExporter().parseAsync(new THREE.Group(), { binary: true })) as ArrayBuffer
		);
		expect(await checkGlb(empty, { height: 1 })).toEqual({
			problems: ['The GLB has no meshes.', 'The GLB has zero or non-finite size.']
		});
	});

	it('adds a line per clip in place of the clip list', async () => {
		const c = await checkGlb(
			await glbWith([bob('Idle', 'Crate'), bob('Hop', 'Crate')], box('Crate'))
		);
		if ('problems' in c) throw new Error(c.problems.join());
		expect(c.text).toContain('Clip checks (pass clip to see one moving):');
		expect(c.text).toMatch(/- Idle \(1\.00 s, 1 tracks/);
		expect(c.text).toMatch(/- Hop \(1\.00 s, 1 tracks/);
		expect(c.text).not.toContain('Animations:');
		expect(c.clip).toBeUndefined();
	});

	it('gives one clip’s detail when asked', async () => {
		const c = await checkGlb(
			await glbWith([bob('Idle', 'Crate'), bob('Hop', 'Crate')], box('Crate')),
			{
				clip: 'Hop'
			}
		);
		if ('problems' in c) throw new Error(c.problems.join());
		expect(c.clip).toBe('Hop');
		expect(c.text).toContain('Clip Hop: 1.00 s, 1 tracks.');
		// No WebGL in jsdom, so no sheet, and the detail doesn't promise one.
		expect(c.png).toBeNull();
		expect(c.text).not.toContain('Motion sheet:');
	});

	it('fails on a clip name it does not have, listing the clips', async () => {
		const bytes = await glbWith([bob('Idle', 'Crate'), bob('Hop', 'Crate')], box('Crate'));
		expect(await checkGlb(bytes, { clip: 'Run' })).toEqual({
			problems: ['No clip named Run. Clips: Idle, Hop.']
		});
		expect(await checkGlb(await glbOf(box('Crate')), { clip: 'Run' })).toEqual({
			problems: ['No clip named Run. The GLB has no clips.']
		});
	});

	it('measures clips on the normalised model', async () => {
		const c = await checkGlb(await glbWith([bob('Idle', 'Crate')], box('Crate')), {
			ground: true,
			clip: 'Idle'
		});
		if ('problems' in c) throw new Error(c.problems.join());
		expect(c.report.feetY).toBeCloseTo(0);
		expect(c.text).toContain('Clip Idle:');
	});
});
