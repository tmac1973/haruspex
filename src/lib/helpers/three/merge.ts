/**
 * `kit.mergeGeometries`: three's merge, but a merge it can't do throws and
 * says why. three's returns null (and logs to a console the model never sees),
 * and the null then fails at `new THREE.Mesh(null)` with an internal message
 * about `morphAttributes` on another line — what a model got for mixing a
 * non-indexed IcosahedronGeometry with indexed boxes (2026-11-07). The error is
 * thrown here, so its stack's first module frame is the merge call.
 */
import type { BufferGeometry } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

const names = (g: BufferGeometry, morph = false) =>
	Object.keys(morph ? g.morphAttributes : g.attributes)
		.sort()
		.join(', ') || 'none';

/** Why three can't merge these, or null when it can. */
export function mergeProblem(geometries: BufferGeometry[]): string | null {
	if (!Array.isArray(geometries) || geometries.length === 0) {
		return 'pass an array of at least one geometry.';
	}
	const first = geometries[0];
	for (let i = 0; i < geometries.length; i++) {
		const g = geometries[i];
		if (!g || !(g as { isBufferGeometry?: boolean }).isBufferGeometry) {
			return `item ${i} is not a geometry (pass mesh.geometry, not the mesh).`;
		}
		if ((g.index === null) !== (first.index === null)) {
			const [indexed, plain] = first.index === null ? [i, 0] : [0, i];
			return `item ${indexed} is indexed and item ${plain} is not. Call .toNonIndexed() on the indexed ones (or mergeVertices on the others) so all match.`;
		}
		if (names(g) !== names(first)) {
			return `item ${i} has attributes ${names(g)} and item 0 has ${names(first)}. Give them the same set (deleteAttribute('uv'), or add the missing one).`;
		}
		if (names(g, true) !== names(first, true)) {
			return `item ${i} has morph targets ${names(g, true)} and item 0 has ${names(first, true)}.`;
		}
	}
	return null;
}

export function checkedMergeGeometries(
	geometries: BufferGeometry[],
	useGroups = false
): BufferGeometry {
	const problem = mergeProblem(geometries);
	if (problem) throw new Error(`kit.mergeGeometries can't merge these: ${problem}`);
	const merged = mergeGeometries(geometries, useGroups);
	if (!merged) {
		throw new Error(
			"kit.mergeGeometries can't merge these: their attributes differ in size or type."
		);
	}
	return merged;
}
