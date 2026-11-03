/**
 * Clip checks that look at parts against each other and the floor, frame by
 * frame: a part passing into another, a part coming away from the body, a
 * planted foot sliding, and a knee or elbow folding the wrong way. Each is a
 * tracker: set up at rest, fed every sampled frame, then asked for findings.
 */
import type { Mesh, Object3D, SkinnedMesh } from 'three';
import type { Three } from '#lib/glb/load.ts';
import type { ClipMotion, TimeSpan } from '#lib/glb/motion.ts';
import { forEachWorldVertex, isSkinned, posedBox, type Part } from '#lib/glb/motionPose.ts';
import { isClosedOpaque, RAY } from '#lib/glb/report.ts';

/** Vertices sampled from a part to test whether it is inside another. */
const INSIDE_SAMPLES = 16;
/** Over this share inside at rest, a pair is a joint or socket and never reported. */
const REST_INSIDE = 0.05;
/** At least this share inside at a frame is passing into. */
const FRAME_INSIDE = 0.25;
/** A part's box grows by this share of the asset's size before testing contact. */
const CONTACT_SLACK = 0.01;
/** Within this of the floor (m), a vertex is planted. */
const PLANTED = 0.01;
/** Fewer planted vertices than this is a graze, not a part standing on the floor. */
const MIN_PLANTED = 3;
/** A stance sliding more than this (m) is reported. */
const SLIDE = 0.03;
/** A fold past this many degrees the wrong way is reported. */
const WRONG_FOLD = 10;

type Box = InstanceType<Three['Box3']>;

/** Times seen, kept as the first and last. */
function note(map: Map<string, TimeSpan>, key: string, t: number): void {
	const s = map.get(key);
	if (s) s.to = t;
	else map.set(key, { from: t, to: t });
}

/** The share of `inner`'s posed vertices inside `host`'s closed volume (ray parity). */
export function insideShare(THREE: Three, inner: Mesh, host: Mesh): number {
	const count = inner.geometry.getAttribute('position')?.count ?? 0;
	if (!count) return 0;
	const pts: InstanceType<Three['Vector3']>[] = [];
	forEachWorldVertex(THREE, inner, Math.ceil(count / INSIDE_SAMPLES), (x, y, z) =>
		pts.push(new THREE.Vector3(x, y, z))
	);
	const mats = Array.isArray(host.material) ? host.material : [host.material];
	const sides = mats.map((m) => m.side);
	for (const m of mats) m.side = THREE.DoubleSide;
	// A skinned host caches its posed bounds; this frame's pose needs fresh ones.
	if (isSkinned(host)) {
		(host as SkinnedMesh).computeBoundingBox();
		(host as SkinnedMesh).computeBoundingSphere();
	}
	const ray = new THREE.Raycaster();
	const dir = new THREE.Vector3(...RAY).normalize();
	let inside = 0;
	try {
		for (const p of pts) {
			ray.set(p, dir);
			const hits = ray.intersectObject(host, false).map((h) => h.distance);
			const crossings = hits.filter((d, k) => k === 0 || d - hits[k - 1] > 1e-7).length;
			if (crossings % 2 === 1) inside++;
		}
	} finally {
		mats.forEach((m, k) => (m.side = sides[k]));
	}
	return inside / pts.length;
}

/** How far apart two relative transforms may be and still count as unmoved. */
const RIGID_EPSILON = 1e-6;

/** `a`'s transform in `b`'s space; a skinned mesh deforms, so it has none. */
export function relative(THREE: Three, a: Mesh, b: Mesh): InstanceType<Three['Matrix4']> | null {
	if (isSkinned(a) || isSkinned(b)) return null;
	return new THREE.Matrix4().copy(b.matrixWorld).invert().multiply(a.matrixWorld);
}

/** Whether two relative transforms are the same, so the parts haven't moved apart. */
export function sameTransform(
	rest: { elements: ArrayLike<number> },
	now: { elements: ArrayLike<number> } | null
): boolean {
	if (!now) return false;
	return Array.from(rest.elements).every((v, i) => Math.abs(v - now.elements[i]) <= RIGID_EPSILON);
}

/**
 * Parts passing into others, and parts coming away from the body.
 *
 * A pair that keeps its rest transform to each other (two meshes under one
 * pivot) can't pass into each other, so it is skipped at that frame. Without
 * this, the fixed ray direction of `insideShare` turns with the pose and two
 * surfaces that touch at rest can flip its parity: a false report that a
 * model then spends its rounds trying to fix.
 */
export function contactTracker(THREE: Three, meshes: Mesh[], stride: number, weld: number) {
	const boxes = () => new Map(meshes.map((m) => [m, posedBox(THREE, [m], stride)]));
	const rest = boxes();
	const all = new THREE.Box3();
	for (const b of rest.values()) all.union(b);
	const size = all.getSize(new THREE.Vector3());
	const slack = Math.max(size.x, size.y, size.z) * CONTACT_SLACK;
	const touches = (m: Mesh, at: Map<Mesh, Box>) => {
		const grown = at.get(m)!.clone().expandByScalar(slack);
		return meshes.some((o) => o !== m && grown.intersectsBox(at.get(o)!));
	};
	const hosts = meshes.filter((m) => isClosedOpaque(m, weld));
	const pairs: { a: Mesh; b: Mesh; rest: InstanceType<Three['Matrix4']> | null }[] = [];
	for (const a of meshes) {
		for (const b of hosts) {
			if (a === b) continue;
			const joined =
				rest.get(a)!.intersectsBox(rest.get(b)!) && insideShare(THREE, a, b) > REST_INSIDE;
			if (!joined) pairs.push({ a, b, rest: relative(THREE, a, b) });
		}
	}
	const unmoved = (p: (typeof pairs)[number]) =>
		!!p.rest && sameTransform(p.rest, relative(THREE, p.a, p.b));
	const attached = meshes.filter((m) => touches(m, rest));
	const passes = new Map<string, TimeSpan>();
	const apart = new Map<string, TimeSpan>();
	const key = (a: Mesh, b: Mesh) => JSON.stringify([a.name, b.name]);
	return {
		frame(t: number) {
			const at = boxes();
			for (const p of pairs) {
				const { a, b } = p;
				if (!at.get(a)!.intersectsBox(at.get(b)!) || unmoved(p)) continue;
				if (insideShare(THREE, a, b) >= FRAME_INSIDE) note(passes, key(a, b), t);
			}
			for (const m of attached) if (!touches(m, at)) note(apart, m.name, t);
		},
		result(): Pick<ClipMotion, 'passes' | 'apart'> {
			return {
				passes: [...passes].map(([k, s]) => {
					const [part, into] = JSON.parse(k) as [string, string];
					return { part, into, ...s };
				}),
				apart: [...apart].map(([part, s]) => ({ part, ...s }))
			};
		}
	};
}

/**
 * Planted parts sliding across the floor. Follows the same vertices from one
 * frame to the next, so a foot rolling onto its toes isn't a slide.
 */
export function slideTracker(THREE: Three, parts: Part[], stride: number, floor: number) {
	const planted = new Map<string, Map<number, [number, number]>>();
	const open = new Map<string, { from: number; slid: number }>();
	const worst = new Map<string, { part: string; slid: number } & TimeSpan>();
	let lastT = 0;
	const close = (name: string) => {
		const s = open.get(name);
		open.delete(name);
		const w = worst.get(name);
		if (s && s.slid > SLIDE && (!w || s.slid > w.slid)) {
			worst.set(name, { part: name, slid: s.slid, from: s.from, to: lastT });
		}
	};
	return {
		frame(t: number) {
			for (const part of parts) {
				const now = new Map<number, [number, number]>();
				forEachWorldVertex(
					THREE,
					part.mesh,
					stride,
					(x, y, z, i) => {
						if (y <= floor + PLANTED) now.set(i, [x, z]);
					},
					part.indices
				);
				const before = planted.get(part.name);
				planted.set(part.name, now);
				// Distinct points: a cone's tip is several vertices in one place.
				const points = new Set(
					[...now.values()].map(([x, z]) => `${Math.round(x * 1e3)},${Math.round(z * 1e3)}`)
				);
				if (points.size < Math.ceil(MIN_PLANTED / stride)) {
					close(part.name);
					continue;
				}
				let step = 0;
				let n = 0;
				for (const [i, [x, z]] of now) {
					const p = before?.get(i);
					if (!p) continue;
					step += Math.hypot(x - p[0], z - p[1]);
					n++;
				}
				const s = open.get(part.name);
				if (s) s.slid += n ? step / n : 0;
				else open.set(part.name, { from: t, slid: 0 });
			}
			lastT = t;
		},
		result(): Pick<ClipMotion, 'slides'> {
			for (const name of [...open.keys()]) close(name);
			return {
				slides: [...worst.values()].map(({ part, slid, from, to }) => ({
					part,
					cm: Math.round(slid * 100),
					from,
					to
				}))
			};
		}
	};
}

const BACKWARD = ['knee', 'shin', 'calf', 'lowerleg'];
const FORWARD = ['elbow', 'forearm', 'lowerarm'];

interface Joint {
	node: Object3D;
	parent: Object3D;
	child: Object3D;
	/** +1: folds backward (a knee); −1: folds forward (an elbow). */
	sign: number;
}

const isMeshNode = (o: Object3D) => (o as Mesh).isMesh === true;

/** Knees and elbows found by name: bones or pivot nodes, never meshes. */
export function jointsOf(root: Object3D): Joint[] {
	const out: Joint[] = [];
	root.traverse((node) => {
		if (isMeshNode(node) || !node.parent || node.parent === root) return;
		const name = node.name.toLowerCase();
		const sign = BACKWARD.some((w) => name.includes(w))
			? 1
			: FORWARD.some((w) => name.includes(w))
				? -1
				: 0;
		if (!sign) return;
		const child = node.children.find(
			(c) => !isMeshNode(c) && !c.name.toLowerCase().includes('socket')
		);
		if (child) out.push({ node, parent: node.parent, child, sign });
	});
	return out;
}

/** The fold at a joint about the side axis (+x), in degrees; positive swings the lower part back (−z). */
export function foldDegrees(
	THREE: Three,
	j: Pick<Joint, 'node' | 'parent' | 'child'>
): number | null {
	const p = j.parent.getWorldPosition(new THREE.Vector3());
	const n = j.node.getWorldPosition(new THREE.Vector3());
	const c = j.child.getWorldPosition(new THREE.Vector3());
	const a = n.clone().sub(p);
	const b = c.clone().sub(n);
	if (a.length() < 1e-3 || b.length() < 1e-3) return null;
	// A limb swung out to the side has little left in the side view to judge.
	const inPlane = (v: InstanceType<Three['Vector3']>) => Math.hypot(v.y, v.z) >= 0.5 * v.length();
	if (!inPlane(a) || !inPlane(b)) return null;
	const cross = a.y * b.z - a.z * b.y;
	const dot = a.y * b.y + a.z * b.z;
	return (Math.atan2(cross, dot) * 180) / Math.PI;
}

/** Knees and elbows folding the wrong way. */
export function jointTracker(THREE: Three, root: Object3D) {
	const joints = jointsOf(root);
	const wrong = new Map<Joint, { degrees: number } & TimeSpan>();
	return {
		checked: joints.map((j) => j.node.name),
		frame(t: number) {
			for (const j of joints) {
				const fold = foldDegrees(THREE, j);
				if (fold === null) continue;
				const against = -fold * j.sign;
				if (against <= WRONG_FOLD) continue;
				const w = wrong.get(j);
				if (w) {
					w.to = t;
					w.degrees = Math.max(w.degrees, against);
				} else wrong.set(j, { degrees: against, from: t, to: t });
			}
		},
		result(): Pick<ClipMotion, 'joints'> {
			return {
				joints: [...wrong].map(([j, w]) => ({
					joint: j.node.name,
					degrees: Math.round(w.degrees),
					from: w.from,
					to: w.to
				}))
			};
		}
	};
}
