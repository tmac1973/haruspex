/**
 * The entry of `static/helpers/three-kit.js` (`scripts/build-three-kit.mjs`):
 * the app's own `three`, its GLB exporter and a small modelling kit, as one
 * classic script. A build module runs in a sandboxed page that can load a
 * classic script from the app's origin but not modules (they would need
 * CORS), so this is how it gets Three.js with no CDN.
 */
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { ConvexGeometry } from 'three/examples/jsm/geometries/ConvexGeometry.js';
import { ParametricGeometry } from 'three/examples/jsm/geometries/ParametricGeometry.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { checkedMergeGeometries } from '#lib/helpers/three/merge.ts';
import { createNoise, random } from '#lib/helpers/three/noise.ts';

/** The module's PNGs by the path it wrote, filled by the runner before it runs (`textures.ts`). */
const textures = new Map<string, THREE.Texture>();

/** The texture for a PNG the module named as a string literal. */
function texture(path: string): THREE.Texture {
	const t = textures.get(path);
	if (!t) {
		throw new Error(
			`kit.texture("${path}"): no such PNG next to the module (paths are read before build runs, so pass a string literal).`
		);
	}
	return t;
}

/** What a build module's `build(THREE, kit)` gets as `kit`. */
export const kit = {
	mergeGeometries: checkedMergeGeometries,
	mergeVertices,
	RoundedBoxGeometry,
	ConvexGeometry,
	ParametricGeometry,
	createNoise,
	random,
	texture
};

(globalThis as unknown as { HaruspexThreeKit: unknown }).HaruspexThreeKit = {
	THREE,
	GLTFExporter,
	kit,
	setTextures: (map: Record<string, THREE.Texture>) => {
		textures.clear();
		for (const [path, t] of Object.entries(map)) textures.set(path, t);
	}
};
