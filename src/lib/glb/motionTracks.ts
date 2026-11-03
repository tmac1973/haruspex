/**
 * Checks that read a clip's tracks alone: tracks that never move, big jumps
 * between rotation keys, and clips that can't play as meant.
 */
import type { AnimationClip } from 'three';

/** A rotation step over this many degrees between two keys is a jump. */
export const JUMP_DEGREES = 90;
const MAX_JUMPS = 4;

export interface TrackChecks {
	dead: string[];
	jumps: { track: string; degrees: number; at: number }[];
	sanity: string[];
}

function moves(values: ArrayLike<number>, size: number): boolean {
	for (let i = size; i < values.length; i++) {
		if (Math.abs(values[i] - values[i % size]) > 1e-5) return true;
	}
	return false;
}

export function trackChecks(clip: AnimationClip): TrackChecks {
	const dead: string[] = [];
	const jumps: TrackChecks['jumps'] = [];
	let late = false;
	for (const track of clip.tracks) {
		const v = track.values;
		if (track.times.length > 1 && !moves(v, track.getValueSize())) dead.push(track.name);
		if (track.times.some((t) => t > clip.duration + 1e-4)) late = true;
		if (!track.name.endsWith('.quaternion')) continue;
		for (let k = 1; k < track.times.length && jumps.length < MAX_JUMPS; k++) {
			let dot = 0;
			for (let j = 0; j < 4; j++) dot += v[(k - 1) * 4 + j] * v[k * 4 + j];
			const degrees = Math.round((2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
			if (degrees > JUMP_DEGREES) jumps.push({ track: track.name, degrees, at: track.times[k] });
		}
	}
	const sanity: string[] = [];
	if (clip.duration <= 0) sanity.push('it lasts 0 s');
	if (clip.tracks.length && clip.tracks.every((t) => t.times.length < 2)) {
		sanity.push('every track has one key, so nothing moves');
	}
	if (late) sanity.push('keys run past its end');
	return { dead, jumps, sanity };
}
