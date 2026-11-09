/**
 * How a GLB moves: a skinned mesh bent by a skeleton's bones, or rigid parts
 * hung under nodes its clips turn and move. Shared by the clip checks and the
 * editor's model viewer.
 */
import type { AnimationClip, Object3D, SkinnedMesh } from 'three';
import type { Three } from '#lib/glb/load.ts';
import { isSkinned, meshesOf } from '#lib/glb/motionPose.ts';

export interface Rig {
	rig: 'skinned' | 'rigid';
	/** Skeleton bones, or for a rigid rig the animated nodes that aren't meshes. */
	bones: number;
}

/** The nodes the clips animate, by name. */
export function trackNodes(THREE: Three, animations: AnimationClip[]): Set<string> {
	const out = new Set<string>();
	for (const clip of animations) {
		for (const t of clip.tracks) out.add(THREE.PropertyBinding.parseTrackName(t.name).nodeName);
	}
	return out;
}

/** Skinned when any mesh is; otherwise rigid, counting the non-mesh nodes in `clipNodes`. */
export function rigOf(root: Object3D, clipNodes: Set<string>): Rig {
	const skinned = meshesOf(root).filter(isSkinned) as SkinnedMesh[];
	if (skinned.length) {
		const bones = new Set(skinned.flatMap((m) => m.skeleton.bones));
		return { rig: 'skinned', bones: bones.size };
	}
	let n = 0;
	root.traverse((o) => {
		if (!(o as { isMesh?: boolean }).isMesh && clipNodes.has(o.name)) n++;
	});
	return { rig: 'rigid', bones: n };
}
