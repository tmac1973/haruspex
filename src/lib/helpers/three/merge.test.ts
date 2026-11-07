import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { checkedMergeGeometries, mergeProblem } from './merge';

describe('checkedMergeGeometries', () => {
	it('merges what three can merge', () => {
		const merged = checkedMergeGeometries([new THREE.BoxGeometry(), new THREE.BoxGeometry()]);
		expect(merged.attributes.position.count).toBe(48);
	});

	it('names the mix of indexed and non-indexed geometries instead of returning null', () => {
		// The 2026-11-07 character: boxes and cylinders with an IcosahedronGeometry.
		const parts = [
			new THREE.BoxGeometry(),
			new THREE.CylinderGeometry(),
			new THREE.IcosahedronGeometry()
		];
		expect(() => checkedMergeGeometries(parts)).toThrow(
			"kit.mergeGeometries can't merge these: item 0 is indexed and item 2 is not. Call .toNonIndexed() on the indexed ones (or mergeVertices on the others) so all match."
		);
	});

	it('names the attribute that one geometry lacks', () => {
		const bare = new THREE.BoxGeometry();
		bare.deleteAttribute('uv');
		expect(mergeProblem([new THREE.BoxGeometry(), bare])).toBe(
			"item 1 has attributes normal, position and item 0 has normal, position, uv. Give them the same set (deleteAttribute('uv'), or add the missing one)."
		);
	});

	it('says when a mesh came where its geometry was meant', () => {
		const mesh = new THREE.Mesh(new THREE.BoxGeometry());
		expect(mergeProblem([new THREE.BoxGeometry(), mesh as never])).toBe(
			'item 1 is not a geometry (pass mesh.geometry, not the mesh).'
		);
		expect(mergeProblem([])).toBe('pass an array of at least one geometry.');
	});
});
