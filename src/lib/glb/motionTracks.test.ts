import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { clip, turn } from './motionFixtures';
import { trackChecks } from './motionTracks';

describe('trackChecks', () => {
	it('finds tracks that never move', () => {
		const still = new THREE.VectorKeyframeTrack('A.position', [0, 1], [1, 2, 3, 1, 2, 3]);
		const moving = new THREE.VectorKeyframeTrack('B.position', [0, 1], [0, 0, 0, 1, 0, 0]);
		expect(trackChecks(clip('c', 1, still, moving)).dead).toEqual(['A.position']);
	});

	it('reports a rotation step over 90° at the later key', () => {
		const r = trackChecks(clip('c', 1, turn('Arm', [0, 0, 1], [0, 0.5, 1], [0, 30, 150])));
		expect(r.jumps).toEqual([{ track: 'Arm.quaternion', degrees: 120, at: 1 }]);
	});

	it('names clips that cannot play as meant', () => {
		const one = new THREE.VectorKeyframeTrack('A.position', [0], [0, 0, 0]);
		expect(trackChecks(clip('c', 0, one)).sanity).toEqual([
			'it lasts 0 s',
			'every track has one key, so nothing moves'
		]);
		const late = new THREE.VectorKeyframeTrack('A.position', [0, 2], [0, 0, 0, 1, 0, 0]);
		expect(trackChecks(clip('c', 1, late)).sanity).toEqual(['keys run past its end']);
	});

	it('notes keys too far apart to read as anything but straight lines', () => {
		const sparse = trackChecks(clip('c', 2, turn('Arm', [0, 0, 1], [0, 1, 2], [0, 45, 0])));
		expect(sparse.sparse).toEqual({ tracks: ['Arm.quaternion'], gap: 1 });
		const times = Array.from({ length: 9 }, (_, i) => i / 4);
		const fine = trackChecks(
			clip(
				'c',
				2,
				turn(
					'Arm',
					[0, 0, 1],
					times,
					times.map((t) => t * 10)
				)
			)
		);
		expect(fine.sparse.tracks).toEqual([]);
	});

	it('notes tracks keyed more often than a game needs', () => {
		const times = Array.from({ length: 121 }, (_, i) => i / 120);
		const r = trackChecks(
			clip(
				'c',
				1,
				turn(
					'Arm',
					[0, 0, 1],
					times,
					times.map((t) => t * 45)
				)
			)
		);
		expect(r.dense.tracks).toBe(1);
		expect(Math.round(r.dense.perSecond)).toBe(120);
	});

	it('finds nothing wrong with a plain clip', () => {
		const r = trackChecks(clip('c', 1, turn('Arm', [0, 0, 1], [0, 1], [0, 45])));
		expect(r).toMatchObject({ dead: [], jumps: [], sanity: [], dense: { tracks: 0 } });
	});
});
