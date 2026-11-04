/**
 * Checks that read a clip's tracks alone: tracks that never move, big jumps
 * between rotation keys, clips that can't play as meant, and keys too sparse
 * to read as anything but straight lines or so dense they bloat the file.
 */
import { InterpolateLinear, type AnimationClip, type KeyframeTrack } from 'three';

/** A rotation step over this many degrees between two keys is a jump. */
export const JUMP_DEGREES = 90;
const MAX_JUMPS = 4;
/** Linear keys further apart than this (s) on a moving track read as mechanical. */
export const SPARSE_GAP = 0.3;
/** More keys a second than this on a track bloat the file; 30 is plenty for a game. */
export const DENSE_KEYS = 60;

export interface TrackChecks {
	dead: string[];
	jumps: { track: string; degrees: number; at: number }[];
	sanity: string[];
	/** Moving tracks keyed linearly with a gap over `SPARSE_GAP`, and the widest gap (s). */
	sparse: { tracks: string[]; gap: number };
	/** Tracks keyed more than `DENSE_KEYS` times a second, and the most (keys/s). */
	dense: { tracks: number; perSecond: number };
}

function moves(values: ArrayLike<number>, size: number): boolean {
	for (let i = size; i < values.length; i++) {
		if (Math.abs(values[i] - values[i % size]) > 1e-5) return true;
	}
	return false;
}

/** Rotation steps over `JUMP_DEGREES` between two keys, added to `jumps` up to `MAX_JUMPS`. */
function quaternionJumps(track: KeyframeTrack, jumps: TrackChecks['jumps']): void {
	const v = track.values;
	for (let k = 1; k < track.times.length && jumps.length < MAX_JUMPS; k++) {
		let dot = 0;
		for (let j = 0; j < 4; j++) dot += v[(k - 1) * 4 + j] * v[k * 4 + j];
		const degrees = Math.round((2 * Math.acos(Math.min(1, Math.abs(dot))) * 180) / Math.PI);
		if (degrees > JUMP_DEGREES) jumps.push({ track: track.name, degrees, at: track.times[k] });
	}
}

/** A track's widest gap between keys (s), and its keys a second. */
function keySpacing(track: KeyframeTrack): { gap: number; perSecond: number } {
	const t = track.times;
	let gap = 0;
	for (let k = 1; k < t.length; k++) gap = Math.max(gap, t[k] - t[k - 1]);
	const span = t.length > 1 ? t[t.length - 1] - t[0] : 0;
	return { gap, perSecond: span > 0 ? (t.length - 1) / span : 0 };
}

export function trackChecks(clip: AnimationClip): TrackChecks {
	const dead: string[] = [];
	const jumps: TrackChecks['jumps'] = [];
	let late = false;
	const sparse: TrackChecks['sparse'] = { tracks: [], gap: 0 };
	const dense: TrackChecks['dense'] = { tracks: 0, perSecond: 0 };
	for (const track of clip.tracks) {
		const v = track.values;
		const still = track.times.length < 2 || !moves(v, track.getValueSize());
		if (track.times.length > 1 && still) dead.push(track.name);
		const keys = keySpacing(track);
		if (!still && track.getInterpolation() === InterpolateLinear && keys.gap > SPARSE_GAP) {
			sparse.tracks.push(track.name);
			sparse.gap = Math.max(sparse.gap, keys.gap);
		}
		if (keys.perSecond > DENSE_KEYS + 0.5) {
			dense.tracks++;
			dense.perSecond = Math.max(dense.perSecond, keys.perSecond);
		}
		if (track.times.some((t) => t > clip.duration + 1e-4)) late = true;
		if (track.name.endsWith('.quaternion')) quaternionJumps(track, jumps);
	}
	const sanity: string[] = [];
	if (clip.duration <= 0) sanity.push('it lasts 0 s');
	if (clip.tracks.length && clip.tracks.every((t) => t.times.length < 2)) {
		sanity.push('every track has one key, so nothing moves');
	}
	if (late) sanity.push('keys run past its end');
	return { dead, jumps, sanity, sparse, dense };
}
