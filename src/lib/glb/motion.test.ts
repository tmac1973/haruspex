import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clip, gltf, move, pivotRig, skinnedLeg, turn } from './motionFixtures';
import { inspectMotion, sampleTimes } from './motion';

const ROOT_AT = (y: number, x = 0): [number, number, number] => [x, y, 0];

/** The pivot rig with its whole body under a 'Rig' node the clip can move. */
function movable() {
	const inner = pivotRig();
	inner.name = 'Rig';
	const root = new THREE.Group();
	root.add(inner);
	root.updateMatrixWorld(true);
	return root;
}

describe('inspectMotion', () => {
	it('returns nothing for a GLB without clips', () => {
		expect(inspectMotion(THREE, gltf(pivotRig(), []))).toEqual([]);
	});

	it('measures sinking, lifting and drift with their times', () => {
		const root = movable();
		const sink = clip(
			'Sink',
			1,
			move('Rig', [0, 0.5, 1], [ROOT_AT(0), ROOT_AT(-0.03), ROOT_AT(0)])
		);
		const hop = clip('Hop', 1, move('Rig', [0, 0.5, 1], [ROOT_AT(0), ROOT_AT(0.05), ROOT_AT(0)]));
		const slide = clip('Slide', 1, move('Rig', [0, 1], [ROOT_AT(0), ROOT_AT(0, 0.2)]));
		const [s, h, d] = inspectMotion(THREE, gltf(root, [sink, hop, slide]));
		expect(s.sink).toBeCloseTo(0.03, 2);
		expect(s.sinkAt).toBeCloseTo(0.5, 1);
		expect(h.lift).toBeCloseTo(0.05, 2);
		expect(h.sink).toBe(0);
		expect(d.drift).toBeCloseTo(0.2, 2);
	});

	it('measures the loop seam and the part that moves most', () => {
		const root = pivotRig();
		const loop = clip('Loop', 1, turn('Shoulder', [0, 0, 1], [0, 0.5, 1], [0, 60, 0]));
		const stay = clip('Stay', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 60]));
		const [l, s] = inspectMotion(THREE, gltf(root, [loop, stay]));
		expect(l.seam).toBeLessThan(1e-4);
		expect(s.seam).toBeGreaterThan(0.1);
		expect(s.seamPart).toBe('Arm');
		expect(s.fastest).toEqual(['Arm']);
		// The loop's key pose is halfway: the arm at its highest, then back.
		expect(l.reachPart).toBe('Arm');
		expect(l.reachAt).toBeCloseTo(0.5, 1);
		expect(l.reach).toBeGreaterThan(0.2);
	});

	it('reads a loop and a walk from the name, unless told', () => {
		const root = pivotRig();
		const still = (name: string) => clip(name, 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 0]));
		const [i, w, a] = inspectMotion(
			THREE,
			gltf(root, [still('Idle'), still('Walk'), still('Wave')]),
			{
				loops: { Wave: true }
			}
		);
		expect([i.loop, i.locomotion]).toEqual([true, false]);
		expect([w.loop, w.locomotion]).toEqual([true, true]);
		expect([a.loop, a.locomotion]).toEqual([true, false]);
	});

	it("measures a walk's travel and names the track that carries it", () => {
		const walk = clip('Walk', 1, move('Rig', [0, 1], [ROOT_AT(0), [0, 0, 0.5]]));
		const [w] = inspectMotion(THREE, gltf(movable(), [walk]));
		expect(w.travel).toBeCloseTo(0.5, 2);
		expect(w.travelDir[1]).toBeGreaterThan(0.4);
		expect(w.travelTrack).toBe('Rig.position');
		// Out and back still travels, for a walk.
		const there = clip('Walk', 1, move('Rig', [0, 0.5, 1], [ROOT_AT(0), [0, 0, 0.5], ROOT_AT(0)]));
		expect(inspectMotion(THREE, gltf(movable(), [there]))[0].travel).toBeGreaterThan(0.45);
		const lunge = clip('Lunge', 1, move('Rig', [0, 0.5, 1], [ROOT_AT(0), [0, 0, 0.5], ROOT_AT(0)]));
		expect(inspectMotion(THREE, gltf(movable(), [lunge]))[0].travel).toBeLessThan(1e-4);
	});

	it('finds a loop that changes speed at its seam, and not one that turns there as it does halfway', () => {
		const root = pivotRig();
		const smooth = Array.from({ length: 33 }, (_, i) => i / 32);
		const swing = (u: number) => 30 * Math.sin(2 * Math.PI * u);
		// Eased in: the same poses, but slow out of the start and fast into the end.
		const eased = clip(
			'Idle',
			1,
			turn(
				'Shoulder',
				[0, 0, 1],
				smooth,
				smooth.map((u) => swing(u ** 1.6))
			)
		);
		const even = clip('Idle', 1, turn('Shoulder', [0, 0, 1], smooth, smooth.map(swing)));
		const triangle = clip('Idle', 1, turn('Shoulder', [0, 0, 1], [0, 0.5, 1], [0, 40, 0]));
		const [e, v, t] = inspectMotion(THREE, gltf(root, [eased, even, triangle]));
		expect(e.hitch?.part).toBe('Arm');
		expect(v.hitch).toBeNull();
		expect(t.hitch).toBeNull();
	});

	it('measures how far a clip starts and ends from the rest pose', () => {
		const raise = clip('Wave', 1, turn('Shoulder', [0, 0, 1], [0, 1], [30, 0]));
		const [r] = inspectMotion(THREE, gltf(pivotRig(), [raise]));
		expect(r.fromRest.start).toBeGreaterThan(0.1);
		expect(r.fromRest.startPart).toBe('Arm');
		expect(r.fromRest.end).toBeLessThan(1e-4);
	});

	it('leaves the scene at rest', () => {
		const root = pivotRig();
		const arm = root.getObjectByName('Arm')!;
		const before = arm.getWorldPosition(new THREE.Vector3());
		inspectMotion(THREE, gltf(root, [clip('Up', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 90]))]));
		expect(arm.getWorldPosition(new THREE.Vector3()).distanceTo(before)).toBeLessThan(1e-6);
	});

	it('names the rig, and follows a skinned mesh bone by bone', () => {
		const { root } = skinnedLeg();
		const [k] = inspectMotion(
			THREE,
			gltf(root, [clip('Kick', 1, turn('Shin', [1, 0, 0], [0, 1], [0, 90]))])
		);
		expect(k.rig).toBe('skinned');
		expect(k.bones).toBe(3);
		expect(k.seamPart).toBe('Shin');
		const [r] = inspectMotion(
			THREE,
			gltf(pivotRig(), [clip('Up', 1, turn('Shoulder', [0, 0, 1], [0, 1], [0, 90]))])
		);
		expect(r).toMatchObject({ rig: 'rigid', bones: 1 });
	});
});

describe('sampleTimes', () => {
	it('spans the clip, and gives one frame for a 0 s clip', () => {
		expect(sampleTimes(1, 3)).toEqual([0, 0.5, 1]);
		expect(sampleTimes(0, 16)).toEqual([0]);
	});
});
