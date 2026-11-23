/**
 * Lengthening a song with ACE-Step's `repaint` task: a window past the end
 * adds music there, and one before the start adds an intro (an end of -1
 * then means the source's start). Shared by `edit_music`'s extend and the
 * Video sequence job's music beds.
 */
import type { MusicRequest } from '#lib/music/types.ts';

/** The most one extend adds, in seconds. */
export const MAX_EXTEND_SECONDS = 240;

const round = (s: number) => Math.round(s * 10) / 10;

/** The request fields that add `add` seconds to a song `len` seconds long. */
export function extendFields(
	len: number,
	add: number,
	at: 'start' | 'end' = 'end'
): Pick<MusicRequest, 'repaintStart' | 'repaintEnd' | 'durationSec'> {
	const durationSec = round(len + add);
	return at === 'start'
		? { repaintStart: -add, repaintEnd: -1, durationSec }
		: { repaintStart: round(len), repaintEnd: durationSec, durationSec };
}
