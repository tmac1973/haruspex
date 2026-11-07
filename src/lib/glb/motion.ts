/**
 * What a model should learn about each animation clip in a GLB before it
 * calls the clip done: whether it goes through or leaves the floor, whether
 * it loops back to where it started, whether a walk carries the body away
 * instead of playing in place, how far it wanders, and what is wrong with its
 * tracks. Samples each clip at a fixed number of frames, so the cost
 * doesn't grow with its length. Leaves the scene in its rest pose.
 */
import type { AnimationClip, Object3D, SkinnedMesh } from 'three';
import type { LoadedGlb, Three } from '#lib/glb/load.ts';
import {
	isSkinned,
	median,
	meshesOf,
	partCentre,
	partsOf,
	posedBox,
	poser,
	strideFor,
	type Part
} from '#lib/glb/motionPose.ts';
import { contactTracker, jointTracker, PLANTED, slideTracker } from '#lib/glb/motionParts.ts';
import { trackChecks, type TrackChecks } from '#lib/glb/motionTracks.ts';
import { weldFor } from '#lib/glb/report.ts';
import { LOOPING_CLIP } from '#lib/models3d/spec/types.ts';

export const ANALYSIS_FRAMES = 16;
/** Through the floor by more than this (m) is a problem. */
export const FLOOR_SINK = 0.01;
/**
 * The whole model off the floor by more than this (m) is reported: the same as
 * planted, so a foot can't hover just out of the slide check and pass.
 */
export const FLOOR_LIFT = PLANTED;
/** The most a looping clip's last pose may sit from its first: this share of the height, or 1 cm. */
export const LOOP_SEAM = 0.02;
/** A walk's body may wander this share of the height from where it starts, in place. */
export const ROOT_WANDER = 0.15;

/** Clips that move the model across the floor in a game: they play in place. */
export const LOCOMOTION_CLIP = /walk|run|jog|trot|gallop|sprint|crawl|sneak|strafe|march/i;
/** Clips that leave the floor by design, so lifting off it is no fault. */
const AIRBORNE_CLIP = /run|jog|sprint|gallop|jump|hop|leap|fly|swim/i;
const TRAILS = 5;

export interface TimeSpan {
	from: number;
	to: number;
}

export interface ClipMotion extends TrackChecks {
	name: string;
	duration: number;
	tracks: number;
	/** Whether it loops: the spec's word, or else read from its name. */
	loop: boolean;
	/** Whether its name makes it a walk or run, which plays in place. */
	locomotion: boolean;
	/** Whether its name lets it leave the floor (a run, a jump). */
	airborne: boolean;
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
	/**
	 * How far the body (its lower-median part) travels across the floor (m): from
	 * its first pose to its last, or for a walk the furthest it gets, whichever
	 * is reported; its direction (x, z); and the position track that carries
	 * most of it ('' for none).
	 */
	travel: number;
	travelDir: [number, number];
	travelTrack: string;
	/** How far `travelTrack`'s own keys move its node across the floor, in metres (0 for none). */
	travelTrackFar: number;
	/** For a walk or run, the median velocity of its planted parts (m/s on x, z); else null. */
	stance: { x: number; z: number } | null;
	/** Whether the slides were judged against `stance`: planted feet moving back together. */
	treadmill: boolean;
	/**
	 * When the clip's velocity changes at its loop point (`seamHitch`): the
	 * part that changes most there (m/s, from its end into its start), and its
	 * mean speed through the clip; null when it doesn't.
	 */
	hitch: { part: string; jump: number; speed: number } | null;
	/** How far the first and last poses are from the rest pose (m), at the part furthest off. */
	fromRest: { start: number; startPart: string; end: number; endPart: string };
	/** The parts whose centres travel furthest, for trails. */
	fastest: string[];
	/** The furthest any part gets from where it starts (m), which part, and when: the key pose. */
	reach: number;
	reachPart: string;
	reachAt: number;
	/** The model's height at rest (m), to say how big the motion is. */
	height: number;
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

type Vec = InstanceType<Three['Vector3']>;

/** A loop hitches when its median moving part's velocity changes at the seam by over this share of its mean speed. */
export const HITCH_SHARE = 0.5;
/** A loop's seam must jump this many times more than halfway through to hitch. */
export const HITCH_HALF = 2;
/**
 * Velocities either side of the loop point are read over this share of the
 * clip: wider than the keys are apart, so a kink between two keys reads the
 * same as one on a key.
 */
const SEAM_WINDOW = 1 / 40;

/**
 * How much velocity changes from `before` into `after` (each part's centre at
 * two times `h` apart): the median part's change as a share of its mean speed,
 * and the part that changes most, by how much (m/s), with its mean speed.
 * Null when nothing moves.
 */
export function velocityJump(
	before: [Vec, Vec][],
	after: [Vec, Vec][],
	mean: number[],
	h: number,
	names: string[]
): { share: number; part: string; jump: number; speed: number } | null {
	const parts: { part: string; jump: number; speed: number }[] = [];
	after.forEach(([a0, a1], i) => {
		const [b0, b1] = before[i];
		const out = a1.clone().sub(a0).divideScalar(h);
		const into = b1.clone().sub(b0).divideScalar(h);
		if (mean[i] > 1e-3) parts.push({ part: names[i], jump: out.distanceTo(into), speed: mean[i] });
	});
	if (!parts.length) return null;
	const worst = [...parts].sort((a, b) => b.jump - a.jump)[0];
	return { share: median(parts.map((p) => p.jump / p.speed)), ...worst };
}

/** Each part's centre at `t` and `t + h` (clamped to the clip). */
function centresAround(
	THREE: Three,
	pose: ReturnType<typeof poser>,
	parts: Part[],
	stride: number,
	t: number,
	h: number
): [Vec, Vec][] {
	pose.at(t);
	const a = parts.map((p) => partCentre(THREE, p, stride));
	pose.at(t + h);
	return parts.map((p, i) => [a[i], partCentre(THREE, p, stride)]);
}

/** The part furthest from its rest place, and how far (m). */
function furthest(at: Map<string, Vec>, rest: Map<string, Vec>): { off: number; part: string } {
	let out = { off: 0, part: '' };
	for (const [name, p] of at) {
		const d = rest.get(name)?.distanceTo(p) ?? 0;
		if (d > out.off) out = { off: d, part: name };
	}
	return out;
}

/** How far the model sinks through the floor, rises off it and wanders across it, and when. */
function floorTracker(
	THREE: Three,
	meshes: ReturnType<typeof meshesOf>,
	stride: number,
	floor: number,
	restCentre: Vec
) {
	const out = { sink: 0, sinkAt: 0, lift: 0, liftAt: 0, drift: 0 };
	return {
		frame(t: number) {
			const box = posedBox(THREE, meshes, stride);
			if (floor - box.min.y > out.sink) [out.sink, out.sinkAt] = [floor - box.min.y, t];
			if (box.min.y - floor > out.lift) [out.lift, out.liftAt] = [box.min.y - floor, t];
			const c = box.getCenter(new THREE.Vector3());
			out.drift = Math.max(out.drift, Math.hypot(c.x - restCentre.x, c.z - restCentre.z));
		},
		result: (): Pick<ClipMotion, 'sink' | 'sinkAt' | 'lift' | 'liftAt' | 'drift'> => out
	};
}

/** Where each part's centre goes: the seam, the key pose's reach, and the parts to trail. */
function pathTracker(THREE: Three, parts: Part[], stride: number, rest: Map<string, Vec>) {
	const times: number[] = [];
	const travel = new Map<string, number>();
	const first = new Map<string, InstanceType<Three['Vector3']>>();
	const last = new Map<string, InstanceType<Three['Vector3']>>();
	let reach = 0;
	let reachPart = '';
	let reachAt = 0;
	// The body's move across the floor: the lower-median part's, so a raised arm isn't the body moving.
	let body: [number, number] = [0, 0];
	let bodyMost: [number, number] = [0, 0];
	return {
		frame(t: number) {
			const moves: [number, number][] = [];
			times.push(t);
			for (const part of parts) {
				const p = partCentre(THREE, part, stride);
				const prev = last.get(part.name);
				if (prev) travel.set(part.name, (travel.get(part.name) ?? 0) + prev.distanceTo(p));
				else first.set(part.name, p);
				last.set(part.name, p);
				const start = first.get(part.name)!;
				const away = start.distanceTo(p);
				if (away > reach) [reach, reachPart, reachAt] = [away, part.name, t];
				moves.push([p.x - start.x, p.z - start.z]);
			}
			if (!moves.length) return;
			moves.sort((a, b) => Math.hypot(...a) - Math.hypot(...b));
			body = moves[(moves.length - 1) >> 1];
			if (Math.hypot(...body) > Math.hypot(...bodyMost)) bodyMost = body;
		},
		/** Each part's mean speed through the clip (m/s), in `parts` order. */
		speeds: () => {
			const span = times.length > 1 ? times[times.length - 1] - times[0] : 0;
			return parts.map((p) => (span > 0 ? (travel.get(p.name) ?? 0) / span : 0));
		},
		/** Where the body ends, and the furthest it gets, from where it starts (m on x, z). */
		body: () => ({ net: body, most: bodyMost }),
		result(): Pick<
			ClipMotion,
			'seam' | 'seamPart' | 'fastest' | 'reach' | 'reachPart' | 'reachAt' | 'fromRest'
		> {
			let seam = 0;
			let seamPart = '';
			for (const part of parts) {
				const d = first.get(part.name)?.distanceTo(last.get(part.name)!) ?? 0;
				if (d > seam) [seam, seamPart] = [d, part.name];
			}
			const fastest = [...travel.entries()]
				.filter(([, d]) => d > 1e-4)
				.sort((a, b) => b[1] - a[1])
				.slice(0, TRAILS)
				.map(([name]) => name);
			const start = furthest(first, rest);
			const end = furthest(last, rest);
			return {
				seam,
				seamPart,
				fastest,
				reach,
				reachPart,
				reachAt,
				fromRest: { start: start.off, startPart: start.part, end: end.off, endPart: end.part }
			};
		}
	};
}

/**
 * The position track that moves its node furthest across the floor, in world
 * units at rest, and how far: what carries a clip's travel, when one does.
 */
function travellingTrack(THREE: Three, root: Object3D, clip: AnimationClip) {
	let best = { name: '', far: 0 };
	const scale = new THREE.Vector3();
	for (const t of clip.tracks) {
		if (!t.name.endsWith('.position') || t.getValueSize() !== 3) continue;
		const node = THREE.PropertyBinding.findNode(
			root,
			THREE.PropertyBinding.parseTrackName(t.name).nodeName
		) as Object3D | undefined;
		if (node?.parent) node.parent.getWorldScale(scale);
		else scale.set(1, 1, 1);
		const v = t.values;
		for (let k = 1; k < t.times.length; k++) {
			const far = Math.hypot((v[k * 3] - v[0]) * scale.x, (v[k * 3 + 2] - v[2]) * scale.z);
			if (far > best.far) best = { name: t.name, far };
		}
	}
	return best;
}

/**
 * Whether a loop hitches at its seam: its velocity changes there, read over
 * `SEAM_WINDOW` before its end and after its start. Only the upper half of the model
 * counts, since a foot landing at the loop point jolts the legs, and a knight
 * has many leg parts. The seam has to jump `HITCH_HALF` times more than
 * halfway through: a walk's other foot lands there, and a clip keyed in
 * straight lines turns as sharply on its middle key as at its ends.
 */
function loopHitch(
	THREE: Three,
	pose: ReturnType<typeof poser>,
	parts: Part[],
	stride: number,
	clip: { duration: number; speeds: number[]; upper: (p: Part) => boolean }
): ClipMotion['hitch'] {
	const h = clip.duration * SEAM_WINDOW;
	if (h <= 0) return null;
	const upper = parts.flatMap((p, i) => (clip.upper(p) ? [i] : []));
	const around = (t: number) =>
		centresAround(THREE, pose, parts, stride, t, h).filter((_, i) => upper.includes(i));
	const speeds = upper.map((i) => clip.speeds[i]);
	const names = upper.map((i) => parts[i].name);
	const seam = velocityJump(around(clip.duration - h), around(0), speeds, h, names);
	const half = clip.duration / 2;
	const mid = velocityJump(around(half - h), around(half), speeds, h, names);
	if (!seam || seam.share <= HITCH_SHARE || (mid && seam.share <= HITCH_HALF * mid.share)) {
		return null;
	}
	return { part: seam.part, jump: seam.jump, speed: seam.speed };
}

/** How far the body travels, which way, and the track that carries it. */
function travelOf(
	THREE: Three,
	root: Object3D,
	clip: AnimationClip,
	moved: { net: [number, number]; most: [number, number] },
	locomotion: boolean,
	height: number
): Pick<ClipMotion, 'travel' | 'travelDir' | 'travelTrack' | 'travelTrackFar'> {
	// A walk that wanders far and comes back still travels; anything else is judged by where it ends.
	const wanders = locomotion && Math.hypot(...moved.most) > ROOT_WANDER * height;
	const dir = wanders ? moved.most : moved.net;
	const far = Math.hypot(...dir);
	const carrier = travellingTrack(THREE, root, clip);
	const carries = carrier.far >= far / 2 && far > 0;
	return {
		travel: far,
		travelDir: dir,
		travelTrack: carries ? carrier.name : '',
		travelTrackFar: carries ? carrier.far : 0
	};
}

export interface MotionOptions {
	/** Whether each clip loops, by name, as a spec says; other clips go by their names. */
	loops?: Record<string, boolean>;
}

/** Measure every clip; `[]` when the GLB has none. */
export function inspectMotion(
	THREE: Three,
	gltf: LoadedGlb,
	opts: MotionOptions = {}
): ClipMotion[] {
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
	const restCentres = new Map(parts.map((p) => [p.name, partCentre(THREE, p, stride)]));

	return gltf.animations.map((clip) => {
		const loop = opts.loops?.[clip.name] ?? LOOPING_CLIP.test(clip.name);
		const locomotion = LOCOMOTION_CLIP.test(clip.name);
		const pose = poser(THREE, root, clip);
		const ground = floorTracker(THREE, meshes, stride, floor, restCentre);
		const paths = pathTracker(THREE, parts, stride, restCentres);
		let hitch: ClipMotion['hitch'];
		const contacts = contactTracker(THREE, meshes, stride, weld);
		const slides = slideTracker(THREE, parts, stride, floor, { locomotion, height: size.y });
		const joints = jointTracker(THREE, root);
		try {
			for (const t of sampleTimes(clip.duration, ANALYSIS_FRAMES)) {
				pose.at(t);
				ground.frame(t);
				paths.frame(t);
				contacts.frame(t);
				slides.frame(t);
				joints.frame(t);
			}
			hitch = loop
				? loopHitch(THREE, pose, parts, stride, {
						duration: clip.duration,
						speeds: paths.speeds(),
						upper: (p) => restCentres.get(p.name)!.y > floor + size.y / 2
					})
				: null;
		} finally {
			pose.stop();
		}
		return {
			name: clip.name,
			duration: clip.duration,
			tracks: clip.tracks.length,
			loop,
			locomotion,
			airborne: AIRBORNE_CLIP.test(clip.name),
			...rig,
			...ground.result(),
			...travelOf(THREE, root, clip, paths.body(), locomotion, size.y),
			height: size.y,
			...paths.result(),
			hitch,
			...trackChecks(clip),
			...contacts.result(),
			...slides.result(),
			...joints.result(),
			jointsChecked: joints.checked
		};
	});
}
