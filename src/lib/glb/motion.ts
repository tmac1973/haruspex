/**
 * What a model should learn about each animation clip in a GLB before it
 * calls the clip done: whether it goes through or leaves the floor, whether
 * it loops back to where it started, how far it wanders, and what is wrong
 * with its tracks. Samples each clip at a fixed number of frames, so the cost
 * doesn't grow with its length. Leaves the scene in its rest pose.
 */
import type { Object3D, SkinnedMesh } from 'three';
import type { LoadedGlb, Three } from '#lib/glb/load.ts';
import {
	isSkinned,
	meshesOf,
	partCentre,
	partsOf,
	posedBox,
	poser,
	strideFor
} from '#lib/glb/motionPose.ts';
import { contactTracker, jointTracker, slideTracker } from '#lib/glb/motionParts.ts';
import { trackChecks, type TrackChecks } from '#lib/glb/motionTracks.ts';
import { weldFor } from '#lib/glb/report.ts';

export const ANALYSIS_FRAMES = 16;
/** Through the floor by more than this (m) is a problem. */
export const FLOOR_SINK = 0.01;
/** The whole model off the floor by more than this (m) is reported. */
export const FLOOR_LIFT = 0.02;
const TRAILS = 5;

export interface TimeSpan {
	from: number;
	to: number;
}

export interface ClipMotion extends TrackChecks {
	name: string;
	duration: number;
	tracks: number;
	rig: 'skinned' | 'rigid';
	/** Skeleton bones, or for a rigid rig the animated nodes that aren't meshes. */
	bones: number;
	/** Through the floor by this much at its worst (m; 0 when never), and when. */
	sink: number;
	sinkAt: number;
	/** The lowest point's highest rise above the floor (m), and when. */
	lift: number;
	liftAt: number;
	/** How far the last pose is from the first (m), and the part that moves most. */
	seam: number;
	seamPart: string;
	/** How far the model's centre wanders across the floor (m). */
	drift: number;
	/** The parts whose centres travel furthest, for trails. */
	fastest: string[];
	passes: ({ part: string; into: string } & TimeSpan)[];
	apart: ({ part: string } & TimeSpan)[];
	slides: ({ part: string; cm: number } & TimeSpan)[];
	joints: ({ joint: string; degrees: number } & TimeSpan)[];
	jointsChecked: string[];
}

/** Evenly spaced sample times over `[0, duration]`. */
export function sampleTimes(duration: number, frames: number): number[] {
	if (duration <= 0) return [0];
	return Array.from({ length: frames }, (_, f) => (duration * f) / (frames - 1));
}

function rigOf(root: Object3D, clipNodes: Set<string>): { rig: ClipMotion['rig']; bones: number } {
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

function trackNodes(gltf: LoadedGlb, THREE: Three): Set<string> {
	const out = new Set<string>();
	for (const clip of gltf.animations) {
		for (const t of clip.tracks) out.add(THREE.PropertyBinding.parseTrackName(t.name).nodeName);
	}
	return out;
}

/** Measure every clip; `[]` when the GLB has none. */
export function inspectMotion(THREE: Three, gltf: LoadedGlb): ClipMotion[] {
	if (!gltf.animations.length) return [];
	const root = gltf.scene;
	root.updateMatrixWorld(true);
	const meshes = meshesOf(root);
	const stride = strideFor(meshes);
	const parts = partsOf(root);
	const rest = posedBox(THREE, meshes, stride);
	const floor = rest.min.y;
	const restCentre = rest.getCenter(new THREE.Vector3());
	const rig = rigOf(root, trackNodes(gltf, THREE));
	const size = rest.getSize(new THREE.Vector3());
	const weld = weldFor(Math.max(size.x, size.y, size.z));

	return gltf.animations.map((clip) => {
		const pose = poser(THREE, root, clip);
		let sink = 0;
		let sinkAt = 0;
		let lift = 0;
		let liftAt = 0;
		let drift = 0;
		const travel = new Map<string, number>();
		const first = new Map<string, InstanceType<Three['Vector3']>>();
		const last = new Map<string, InstanceType<Three['Vector3']>>();
		const contacts = contactTracker(THREE, meshes, stride, weld);
		const slides = slideTracker(THREE, parts, stride, floor);
		const joints = jointTracker(THREE, root);
		try {
			for (const t of sampleTimes(clip.duration, ANALYSIS_FRAMES)) {
				pose.at(t);
				const box = posedBox(THREE, meshes, stride);
				if (floor - box.min.y > sink) [sink, sinkAt] = [floor - box.min.y, t];
				if (box.min.y - floor > lift) [lift, liftAt] = [box.min.y - floor, t];
				const c = box.getCenter(new THREE.Vector3());
				drift = Math.max(drift, Math.hypot(c.x - restCentre.x, c.z - restCentre.z));
				for (const part of parts) {
					const p = partCentre(THREE, part, stride);
					const prev = last.get(part.name);
					if (prev) travel.set(part.name, (travel.get(part.name) ?? 0) + prev.distanceTo(p));
					else first.set(part.name, p);
					last.set(part.name, p);
				}
				contacts.frame(t);
				slides.frame(t);
				joints.frame(t);
			}
		} finally {
			pose.stop();
		}
		let seam = 0;
		let seamPart = '';
		for (const part of parts) {
			const d = first.get(part.name)!.distanceTo(last.get(part.name)!);
			if (d > seam) [seam, seamPart] = [d, part.name];
		}
		const fastest = [...travel.entries()]
			.filter(([, d]) => d > 1e-4)
			.sort((a, b) => b[1] - a[1])
			.slice(0, TRAILS)
			.map(([name]) => name);
		return {
			name: clip.name,
			duration: clip.duration,
			tracks: clip.tracks.length,
			...rig,
			sink,
			sinkAt,
			lift,
			liftAt,
			seam,
			seamPart,
			drift,
			fastest,
			...trackChecks(clip),
			...contacts.result(),
			...slides.result(),
			...joints.result(),
			jointsChecked: joints.checked
		};
	});
}
