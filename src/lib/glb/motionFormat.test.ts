import { describe, expect, it } from 'vitest';
import type { ClipMotion } from './motion';
import { clipProblems, formatClip, formatClipLines } from './motionFormat';

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
