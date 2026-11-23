/**
 * A speaking section as clips: its lines packed into windows no longer than
 * the speaking instance's longest clip, a line too long for one window split
 * at its pauses, and each window one S2V clip from the section's portrait
 * with the window's slice of the speech as its sound. Pure: the Speech stage
 * speaks the lines and passes their lengths and pauses in; before then, each
 * line's length is estimated at 150 words a minute.
 */
import type { VideoLimits } from '#lib/toolchest/models.ts';
import { fitClip, maxClipFrames } from '#lib/videogen/fit.ts';
import type { SpeakingSection } from '#lib/sequence/spec/types.ts';

/** A spoken line's WAV, as the Speech stage made it. */
export interface LineSpeech {
	/** Relative to the episode folder. */
	file: string;
	secs: number;
	/** The WAV's hash: a line spoken again gets a new one. */
	hash: string;
	/** Its pauses, in its own seconds. */
	silences: { start: number; end: number }[];
}

/** The speaking instance, and the lines spoken so far, by line id. */
export interface Speaking {
	limits: VideoLimits;
	speech?: Record<string, LineSpeech>;
}

/** One stretch of one line in a window. */
export interface WindowPart {
	file: string;
	line_hash: string;
	from_secs: number;
	to_secs: number;
}

/** A window's sound: its parts joined end to end into `out`. */
export interface WindowAudio {
	parts: WindowPart[];
	/** Relative to the episode folder. */
	out: string;
}

const WORDS_PER_SECOND = 150 / 60;
/** No piece of a split line is shorter than this. */
const MIN_PIECE = 1;

/** A line's length before it is spoken: 150 words a minute, at least a second. */
export function estimateLineSecs(text: string): number {
	const words = text.split(/\s+/).filter(Boolean).length;
	return Math.max(1, words / WORDS_PER_SECOND);
}

const pad = (n: number) => String(n).padStart(2, '0');

/** A spoken line's WAV path, relative to the episode folder. */
export const lineFile = (section: string, n: number) => `narration/${section}-line-${pad(n)}.wav`;
/** A window's WAV path, relative to the episode folder. */
export const windowFile = (section: string, n: number) => `narration/${section}-win-${pad(n)}.wav`;

/** The size, frame rate and longest clip (in seconds) of the speaking instance. */
export function speakingFormat(limits: VideoLimits) {
	const fit = fitClip(limits, '', { portrait: false });
	const frames = maxClipFrames(limits, fit.width, fit.height);
	const cap = Number.isFinite(frames) ? frames : (limits.maxFrames ?? limits.defaultFrames);
	return { width: fit.width, height: fit.height, fps: fit.fps, frames: cap, secs: cap / fit.fps };
}

/**
 * `from`–`to` of a line cut into pieces of at most `cap` seconds: at the
 * pause nearest the middle, else the middle, again until each fits.
 */
export function splitLine(
	from: number,
	to: number,
	silences: LineSpeech['silences'],
	cap: number
): { from: number; to: number }[] {
	if (to - from <= cap + 1e-6) return [{ from, to }];
	const middle = (from + to) / 2;
	const cuts = silences
		.map((s) => (s.start + s.end) / 2)
		.filter((t) => t - from >= MIN_PIECE && to - t >= MIN_PIECE)
		.sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle));
	const at = cuts[0] ?? middle;
	return [...splitLine(from, at, silences, cap), ...splitLine(at, to, silences, cap)];
}

/** The section's windows: parts in order, each window at most `cap` seconds. */
export function windowsOf(
	section: SpeakingSection,
	speaking: Speaking,
	cap: number
): { parts: WindowPart[]; secs: number }[] {
	const windows: { parts: WindowPart[]; secs: number }[] = [];
	section.lines.forEach((line, i) => {
		const spoken = speaking.speech?.[line.id];
		const secs = spoken?.secs ?? estimateLineSecs(line.text);
		const file = spoken?.file ?? lineFile(section.id, i + 1);
		for (const piece of splitLine(0, secs, spoken?.silences ?? [], cap)) {
			const len = piece.to - piece.from;
			const part = {
				file,
				line_hash: spoken?.hash ?? '',
				from_secs: piece.from,
				to_secs: piece.to
			};
			const last = windows[windows.length - 1];
			if (last && last.secs + len <= cap + 1e-6) {
				last.parts.push(part);
				last.secs += len;
			} else windows.push({ parts: [part], secs: len });
		}
	});
	return windows;
}
