import { describe, expect, it } from 'vitest';
import type { ClipMotion } from './motion';
import { clipNotes, clipProblems, formatClip, formatClipLines } from './motionFormat';

function motion(over: Partial<ClipMotion> = {}): ClipMotion {
	return {
		name: 'Walk',
		duration: 0.82,
		tracks: 18,
		rig: 'rigid',
		bones: 18,
		sink: 0,
		sinkAt: 0,
		lift: 0,
		liftAt: 0,
		seam: 0.01,
		seamPart: 'Mesh_Foot_L',
		drift: 0.02,
		fastest: ['Mesh_Foot_L', 'Mesh_Foot_R'],
		reach: 0.42,
		reachPart: 'Mesh_Hand_R',
		reachAt: 0.4,
		height: 0.7,
		loop: false,
		locomotion: false,
		airborne: false,
		travel: 0,
		travelDir: [0, 0],
		travelTrack: '',
		travelTrackFar: 0,
		stance: null,
		treadmill: false,
		hitch: null,
		fromRest: { start: 0, startPart: '', end: 0, endPart: '' },
		sparse: { tracks: [], gap: 0 },
		dense: { tracks: 0, perSecond: 0 },
		dead: [],
		jumps: [],
		sanity: [],
		passes: [],
		apart: [],
		slides: [],
		joints: [],
		jointsChecked: [],
		...over
	};
}

describe('formatClipLines', () => {
	it('says nothing for no clips', () => {
		expect(formatClipLines([])).toEqual([]);
	});

	it('writes one line per clip', () => {
		const bad = motion({
			name: 'Attack',
			duration: 0.75,
			sink: 0.02,
			sinkAt: 0.48,
			jumps: [{ track: 'Bone_Arm.quaternion', degrees: 140, at: 0.35 }],
			dead: ['Bone_Jaw.quaternion']
		});
		expect(formatClipLines([motion(), bad])).toEqual([
			'Clip checks (pass clip to see one moving):',
			'- Walk (0.82 s, 18 tracks, ends 1 cm from its start): no problems found.',
			'- Attack (0.75 s, 18 tracks, ends 1 cm from its start): through the floor by 2 cm at 0.48 s; Bone_Arm.quaternion turns 140° between two keys at 0.35 s; tracks that never move: Bone_Jaw.quaternion.'
		]);
	});
});

describe('clipProblems', () => {
	it('leaves small dips and lifts alone', () => {
		expect(clipProblems(motion({ sink: 0.005, lift: 0.01 }))).toEqual([]);
	});

	it('reports a lift just over planted, so a foot cannot hover past the slide check', () => {
		expect(clipProblems(motion({ lift: 0.013, liftAt: 0.2 }))).toEqual([
			'off the floor by 1 cm at 0.20 s'
		]);
		expect(clipProblems(motion({ name: 'Jump', lift: 0.3, airborne: true }))).toEqual([]);
	});

	it('reports a loop whose last pose is not its first', () => {
		const open = motion({ name: 'Idle', loop: true, seam: 0.09, seamPart: 'Finger_L' });
		expect(clipProblems(open)).toEqual([
			'loops but ends 9 cm from where it starts (Finger_L moves most): make its last pose its first'
		]);
		expect(clipProblems({ ...open, loop: false })).toEqual([]);
	});

	it('reports a looping walk that carries the body, and the track that does', () => {
		const walk = motion({
			loop: true,
			locomotion: true,
			seam: 0.6,
			travel: 0.6,
			travelDir: [0, 0.6],
			travelTrack: 'Root.position',
			travelTrackFar: 0.6,
			stance: { x: 0, z: 0 }
		});
		expect(clipProblems(walk)).toEqual([
			'carries the body 60 cm forward (Root.position moves 60 cm by its own keys): a game moves the model itself, so it would move twice and jump back each loop. Play it in place, with its planted feet moving back instead'
		]);
		const drift = { ...walk, travelTrack: '', travelTrackFar: 0 };
		expect(clipProblems(drift)[0]).toContain(
			'(no one track carries it: the parts move forward together)'
		);
	});

	it('wants a walk in place to move its planted feet back', () => {
		const walk = motion({ loop: true, locomotion: true, stance: { x: 0, z: 0 } });
		expect(clipProblems(walk)).toEqual([
			'its planted feet stand still: in place, a walk moves them back (−z) at its walking speed, or they skate in a game'
		]);
		const back = { ...walk, stance: { x: 0, z: -1.2 }, treadmill: true };
		expect(clipProblems(back)).toEqual([]);
		expect(clipProblems({ ...back, stance: { x: 0, z: 1.2 } })[0]).toMatch(
			/^its planted feet move forward \(\+z\)/
		);
		expect(clipProblems({ ...back, name: 'WalkBack', stance: { x: 0, z: 1.2 } })).toEqual([]);
	});

	it('reports a loop that hitches, only when it loops', () => {
		const hitch = { part: 'Arm', jump: 1.2, speed: 0.8 };
		const idle = motion({ name: 'Idle', loop: true, hitch });
		expect(clipProblems(idle)).toEqual([
			'hitches at the loop point: Arm changes speed by 1.20 m/s there, against a mean speed of 0.80 m/s, and most parts change too. Make its last keys lead into its first'
		]);
		expect(clipProblems({ ...idle, loop: false })).toEqual([]);
		expect(clipProblems({ ...idle, hitch: { ...hitch, jump: 0.05 } })).toEqual([]);
	});

	it('wants a one-shot to start and end at rest, except one that ends lying down', () => {
		const fromRest = { start: 0.06, startPart: 'Sword', end: 0.2, endPart: 'Torso' };
		const why =
			'a one-shot starts and ends at the rest pose, so the game can blend into and out of it';
		expect(clipProblems(motion({ name: 'Attack', fromRest }))).toEqual([
			`starts 6 cm and ends 20 cm from the rest pose (Sword, Torso): ${why}`
		]);
		expect(clipProblems(motion({ name: 'Die', fromRest }))).toEqual([
			`starts 6 cm from the rest pose (Sword): ${why}`
		]);
		expect(clipProblems(motion({ name: 'Idle', loop: true, fromRest }))).toEqual([]);
	});

	it('notes sparse and dense keys without calling them problems', () => {
		const c = motion({
			sparse: { tracks: ['Spine.quaternion', 'Neck.quaternion'], gap: 0.6 },
			dense: { tracks: 13, perSecond: 120 }
		});
		expect(clipProblems(c)).toEqual([]);
		expect(clipNotes(c)).toEqual([
			'keys up to 0.60 s apart on Spine.quaternion and 1 more: straight lines between them read as mechanical, so key at least every 0.25 s',
			'120 keys a second on 13 tracks: 30 is plenty for a game and keeps the file small'
		]);
		expect(formatClipLines([c])[1]).toMatch(/: no problems found\. Note: keys up to 0\.60 s/);
	});

	it('words a slide on a treadmill as a slip against it', () => {
		const slides = [{ part: 'Sole_L', cm: 7, from: 0.1, to: 0.4 }];
		const walk = motion({ locomotion: true, stance: { x: 0, z: -1 }, treadmill: true, slides });
		expect(clipProblems(walk)).toEqual([
			'Sole_L slips 7 cm against the treadmill at 0.10 s–0.40 s'
		]);
		expect(formatClipLines([walk])[1]).toMatch(/^- Walk \(.*, in place at 1\.00 m\/s\): /);
		expect(formatClip(walk, false)).toContain(
			'In place: its planted feet move back at 1.00 m/s, the speed a game should move the model at.'
		);
	});

	it('caps each kind of finding', () => {
		const jumps = Array.from({ length: 8 }, (_, i) => ({ track: `T${i}`, degrees: 100, at: i }));
		const p = clipProblems(motion({ jumps }));
		expect(p).toHaveLength(7);
		expect(p[6]).toBe('and 2 more jumps');
	});
});

describe('formatClip', () => {
	it('describes the sheet only when it came', () => {
		const withSheet = formatClip(motion(), true);
		expect(withSheet[1]).toMatch(/^Motion sheet: .*Mesh_Foot_L, Mesh_Foot_R/);
		const without = formatClip(motion(), false);
		expect(without.some((l) => l.startsWith('Motion sheet'))).toBe(false);
		expect(without).toContain('Rig: rigid, 18 animated nodes.');
		expect(without).toContain(
			'Ends 1 cm from where it starts (Mesh_Foot_L moves most): a loop needs this near 0.'
		);
		expect(without.at(-1)).toBe('No problems found.');
	});

	it('names the key pose, and says to push a timid one', () => {
		expect(formatClip(motion(), false)).toContain(
			"Key pose: Mesh_Hand_R gets 42 cm from where it starts (60% of the model's height), at 0.40 s. A timid key pose reads as no motion in a game: push it further if it is."
		);
		expect(formatClip(motion({ reach: 0, reachPart: '' }), false)).toContain('Nothing moves.');
	});

	it('says how to fix a sliding foot, only when one slides', () => {
		const hint =
			'A planted part should stay put: turn the joint above it against the body, or lift it off the floor.';
		expect(formatClip(motion(), false)).not.toContain(hint);
		const sliding = motion({ slides: [{ part: 'Foot', cm: 9, from: 0, to: 0.5 }] });
		expect(formatClip(sliding, false)).toContain(hint);
	});

	it('names a skinned rig', () => {
		expect(formatClip(motion({ rig: 'skinned', bones: 2 }), false)).toContain(
			'Rig: skinned, 2 bones.'
		);
	});
});
