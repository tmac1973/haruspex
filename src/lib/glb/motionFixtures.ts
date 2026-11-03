/**
 * Small rigs the motion tests share: a rigid pivot rig and a two-bone skinned
 * leg, each with clips built from plain keyframes. Test code only.
 */
import * as THREE from 'three';
import type { LoadedGlb } from '#lib/glb/load.ts';

export function box(
	name: string,
	size: [number, number, number],
	at: [number, number, number] = [0, 0, 0]
) {
	const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshStandardMaterial());
	mesh.name = name;
	mesh.position.set(...at);
	return mesh;
}

/** A quaternion track turning `node` about `axis` through `degrees`, keyed at `times`. */
export function turn(
	node: string,
	axis: [number, number, number],
	times: number[],
	degrees: number[]
) {
	const q = new THREE.Quaternion();
	const a = new THREE.Vector3(...axis).normalize();
	const values = degrees.flatMap((d) => q.setFromAxisAngle(a, (d * Math.PI) / 180).toArray());
	return new THREE.QuaternionKeyframeTrack(`${node}.quaternion`, times, values);
}

export function move(node: string, times: number[], points: [number, number, number][]) {
	return new THREE.VectorKeyframeTrack(`${node}.position`, times, points.flat());
}

export function clip(name: string, duration: number, ...tracks: THREE.KeyframeTrack[]) {
	return new THREE.AnimationClip(name, duration, tracks);
}

/** A body on the floor and an arm hanging off a shoulder pivot. */
export function pivotRig(): THREE.Group {
	const root = new THREE.Group();
	const body = box('Body', [0.4, 1, 0.4], [0, 0.5, 0]);
	const shoulder = new THREE.Object3D();
	shoulder.name = 'Shoulder';
	shoulder.position.set(0.2, 0.9, 0);
	const arm = box('Arm', [0.5, 0.1, 0.1], [0.25, 0, 0]);
	shoulder.add(arm);
	root.add(body, shoulder);
	root.updateMatrixWorld(true);
	return root;
}

/** A 2 m cylinder standing on the floor, skinned to Thigh (bottom half) and Shin (top half). */
export function skinnedLeg(): { root: THREE.Group; mesh: THREE.SkinnedMesh } {
	const geo = new THREE.CylinderGeometry(0.1, 0.1, 2, 8, 8);
	geo.translate(0, 1, 0);
	const pos = geo.getAttribute('position');
	const index: number[] = [];
	const weight: number[] = [];
	for (let i = 0; i < pos.count; i++) {
		index.push(pos.getY(i) > 1 ? 1 : 0, 0, 0, 0);
		weight.push(1, 0, 0, 0);
	}
	geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(index, 4));
	geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weight, 4));
	const thigh = new THREE.Bone();
	thigh.name = 'Thigh';
	const shin = new THREE.Bone();
	shin.name = 'Shin';
	shin.position.y = 1;
	const foot = new THREE.Bone();
	foot.name = 'Foot';
	foot.position.y = 1;
	thigh.add(shin);
	shin.add(foot);
	const mesh = new THREE.SkinnedMesh(geo, new THREE.MeshStandardMaterial());
	mesh.name = 'Leg';
	mesh.add(thigh);
	mesh.bind(new THREE.Skeleton([thigh, shin, foot]));
	const root = new THREE.Group();
	root.add(mesh);
	root.updateMatrixWorld(true);
	return { root, mesh };
}

export const gltf = (scene: THREE.Object3D, animations: THREE.AnimationClip[]): LoadedGlb => ({
	scene,
	animations
});
