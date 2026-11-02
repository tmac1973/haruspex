/**
 * Scale a GLB to a height and stand it on the floor, then export it again.
 * Off unless asked: a model passes `height` and/or `ground`.
 */
import type { Bounds, Vec3 } from '#lib/glb/report.ts';
import type { LoadedGlb, Three } from '#lib/glb/load.ts';

export interface NormaliseOptions {
	/** Scale uniformly so the asset is this many metres tall. */
	height?: number;
	/** Feet on y = 0, centred on x and z. */
	ground?: boolean;
}

export type NormaliseResult =
	{ bytes: Uint8Array; before: Bounds; after: Bounds } | { error: string };

function boundsOf(THREE: Three, root: LoadedGlb['scene']): Bounds {
	root.updateMatrixWorld(true);
	const box = new THREE.Box3().setFromObject(root);
	const size = box.getSize(new THREE.Vector3());
	const v = (p: { x: number; y: number; z: number }): Vec3 => [p.x, p.y, p.z];
	return { min: v(box.min), max: v(box.max), size: v(size) };
}

/**
 * Normalise `gltf` and export it as GLB bytes. The scene is moved into a new
 * group, so the caller's `gltf` is used up: load the returned bytes to look
 * at the result.
 */
export async function normaliseGlb(
	THREE: Three,
	gltf: LoadedGlb,
	opts: NormaliseOptions
): Promise<NormaliseResult> {
	const { height, ground } = opts;
	if (height !== undefined && !(Number.isFinite(height) && height > 0)) {
		return { error: 'height must be a number of metres above 0.' };
	}
	const before = boundsOf(THREE, gltf.scene);
	const group = new THREE.Group();
	group.name = 'Asset';
	group.add(gltf.scene);
	if (height !== undefined) {
		if (!(before.size[1] > 0)) return { error: 'The asset has no height to scale.' };
		group.scale.setScalar(height / before.size[1]);
	}
	if (ground) {
		const scaled = boundsOf(THREE, group);
		group.position.set(
			-(scaled.min[0] + scaled.max[0]) / 2,
			-scaled.min[1],
			-(scaled.min[2] + scaled.max[2]) / 2
		);
	}
	const after = boundsOf(THREE, group);
	const { GLTFExporter } = await import('three/examples/jsm/exporters/GLTFExporter.js');
	const out = await new GLTFExporter().parseAsync(group, {
		binary: true,
		animations: gltf.animations
	});
	return { bytes: new Uint8Array(out as ArrayBuffer), before, after };
}
