/**
 * Posing a loaded GLB inside one of its clips, and reading where its vertices
 * are then. Shared by the clip checks and the motion sheet. A skinned mesh is
 * read through its skeleton, so every box, centre and lowest point here
 * follows the pose, never the rest shape.
 */
import type { AnimationClip, Mesh, Object3D, SkinnedMesh } from 'three';
import type { Three } from '#lib/glb/load.ts';

/** A frame reads at most about this many vertices. */
export const MAX_FRAME_VERTICES = 20_000;

export interface Poser {
	/** Pose the scene `t` seconds into the clip (held at the end, never wrapped). */
	at(t: number): void;
	/** Back to the rest pose. */
	stop(): void;
}

export function poser(THREE: Three, root: Object3D, clip: AnimationClip): Poser {
	const mixer = new THREE.AnimationMixer(root);
	const action = mixer.clipAction(clip);
	action.setLoop(THREE.LoopOnce, 1);
	action.clampWhenFinished = true;
	action.play();
	return {
		at(t) {
			// A play-once action pauses when it reaches its end; start it fresh.
			action.reset();
			mixer.setTime(Math.min(Math.max(t, 0), clip.duration));
			root.updateMatrixWorld(true);
		},
		stop() {
			// Three restores a binding's original state once no action uses it.
			action.stop();
			mixer.uncacheRoot(root);
			root.updateMatrixWorld(true);
		}
	};
}

export function meshesOf(root: Object3D): Mesh[] {
	const out: Mesh[] = [];
	root.traverse((o) => {
		if ((o as Mesh).isMesh) out.push(o as Mesh);
	});
	return out;
}

export function isSkinned(mesh: Mesh): mesh is SkinnedMesh {
	return (mesh as SkinnedMesh).isSkinnedMesh === true;
}

function vertexCount(mesh: Mesh): number {
	return mesh.geometry.getAttribute('position')?.count ?? 0;
}

/** Every how many vertices a frame reads, to stay near `MAX_FRAME_VERTICES`. */
export function strideFor(meshes: Mesh[]): number {
	const total = meshes.reduce((n, m) => n + vertexCount(m), 0);
	return total <= MAX_FRAME_VERTICES ? 1 : Math.ceil(total / MAX_FRAME_VERTICES);
}

/**
 * Call `fn` with every `stride`-th posed vertex of `mesh` in world space, or
 * of `indices` when given.
 */
export function forEachWorldVertex(
	THREE: Three,
	mesh: Mesh,
	stride: number,
	fn: (x: number, y: number, z: number, index: number) => void,
	indices?: number[]
): void {
	const v = new THREE.Vector3();
	const count = indices ? indices.length : vertexCount(mesh);
	for (let k = 0; k < count; k += stride) {
		// getVertexPosition applies morphs and, on a SkinnedMesh, the skeleton.
		const i = indices ? indices[k] : k;
		mesh.getVertexPosition(i, v).applyMatrix4(mesh.matrixWorld);
		fn(v.x, v.y, v.z, i);
	}
}

/** The world box of `meshes`' posed vertices. */
export function posedBox(THREE: Three, meshes: Mesh[], stride: number) {
	const box = new THREE.Box3();
	const p = new THREE.Vector3();
	for (const m of meshes) {
		forEachWorldVertex(THREE, m, stride, (x, y, z) => box.expandByPoint(p.set(x, y, z)));
	}
	return box;
}

/**
 * A unit the per-part measures follow: a plain mesh, or one bone's share of a
 * skinned mesh (the vertices that bone weighs most).
 */
export interface Part {
	name: string;
	mesh: Mesh;
	indices: number[];
}

function boneShares(mesh: SkinnedMesh): Map<number, number[]> {
	const idx = mesh.geometry.getAttribute('skinIndex');
	const wt = mesh.geometry.getAttribute('skinWeight');
	const out = new Map<number, number[]>();
	for (let i = 0; i < vertexCount(mesh); i++) {
		let best = 0;
		for (let j = 1; j < 4; j++) if (wt.getComponent(i, j) > wt.getComponent(i, best)) best = j;
		const bone = idx.getComponent(i, best);
		const list = out.get(bone);
		if (list) list.push(i);
		else out.set(bone, [i]);
	}
	return out;
}

/** The asset's parts, with names made unique in traversal order (`Leg`, `Leg #2`). */
export function partsOf(root: Object3D): Part[] {
	const parts: Part[] = [];
	const seen = new Map<string, number>();
	const unique = (name: string) => {
		const n = (seen.get(name) ?? 0) + 1;
		seen.set(name, n);
		return n === 1 ? name : `${name} #${n}`;
	};
	for (const mesh of meshesOf(root)) {
		if (isSkinned(mesh) && mesh.geometry.getAttribute('skinIndex')) {
			const bones = mesh.skeleton.bones;
			for (const [b, indices] of boneShares(mesh)) {
				parts.push({ name: unique(bones[b]?.name || `bone ${b}`), mesh, indices });
			}
		} else {
			const all = Array.from({ length: vertexCount(mesh) }, (_, i) => i);
			parts.push({ name: unique(mesh.name || '(unnamed)'), mesh, indices: all });
		}
	}
	return parts;
}

/** The mean of a part's posed world vertices, reading every `stride`-th. */
export function partCentre(THREE: Three, part: Part, stride: number) {
	const c = new THREE.Vector3();
	let n = 0;
	forEachWorldVertex(
		THREE,
		part.mesh,
		stride,
		(x, y, z) => {
			c.x += x;
			c.y += y;
			c.z += z;
			n++;
		},
		part.indices
	);
	return n ? c.divideScalar(n) : c;
}
