/**
 * How long a run will take. Before any clip exists the time is unknown: no
 * table of model speeds is kept, since one server's LTX and another's differ
 * many times over. Once the first clip is made, its wall time stands for
 * every clip.
 */
import type { ClipPlan } from '#lib/sequence/spec/plan.ts';
import type { SequenceSpec } from '#lib/sequence/spec/types.ts';

export interface RunEstimate {
	/** Clips the video model makes, transitions included. */
	clips: number;
	music: number;
	narration: number;
	/** Null until a clip's time is known. */
	minutes: number | null;
	note: string;
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** The run's size, and its time from `secsPerClip` when one has been measured. */
export function estimateRun(
	plan: ClipPlan,
	secsPerClip: number | null,
	spec?: Pick<SequenceSpec, 'sound'>
): RunEstimate {
	const clips = plan.items.filter((i) => i.kind === 'generate').length;
	const music = spec?.sound.music.length ?? 0;
	const narration = spec?.sound.narration.length ?? 0;
	const minutes =
		secsPerClip !== null && secsPerClip > 0 ? Math.round((clips * secsPerClip) / 60) : null;
	const extras = [
		music ? plural(music, 'music bed') : '',
		narration ? plural(narration, 'narration line') : ''
	].filter(Boolean);
	const what = [plural(clips, 'clip'), ...extras].join(', ');
	const note =
		minutes === null
			? `${what}. How long it takes is unknown until the first clip is made.`
			: `${what}: about ${plural(minutes, 'minute')} at the first clip's pace.`;
	return { clips, music, narration, minutes, note };
}
