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
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { createNoise, random } from '#lib/helpers/three/noise.ts';

/** What a build module's `build(THREE, kit)` gets as `kit`. */
export const kit = {
	mergeGeometries,
	mergeVertices,
	RoundedBoxGeometry,
	ConvexGeometry,
	ParametricGeometry,
	createNoise,
	random
};

(globalThis as unknown as { HaruspexThreeKit: unknown }).HaruspexThreeKit = {
	THREE,
	GLTFExporter,
	kit
};
