/**
 * The Sound stage: the music beds and narration the spec names.
 *
 * A bed is as long as the run of sections under it. Up to 240 s it is one
 * song. Longer, where the music model can repaint, a 240 s song is extended
 * to length (240 s at a time, as `edit_music` does), up to 600 s a song;
 * past that, or where it can't, several songs with the bed's caption are
 * joined end to end with 2 s crossfades. Each narration line is spoken by
 * Settings → Audio → Speech engine: with Kokoro in the line's voice or
 * Settings → Audio's, with a llama.cpp server in the line's saved voice.
 */
import type { MusicRequest } from '#lib/music/types.ts';
import { MAX_EXTEND_SECONDS, extendFields } from '#lib/music/extend.ts';
import type { FileProgress } from '#lib/sequence/spec/progress.ts';
import type { MusicBed, SequenceSpec } from '#lib/sequence/spec/types.ts';

/** The longest song one request makes. */
export const MAX_SONG_SECONDS = 240;
/** The longest song extending makes. */
export const MAX_EXTENDED_SECONDS = 600;
/** How long one song crossfades into the next. */
export const SONG_CROSSFADE_SECONDS = 2;

/** How a bed is made: each song's length, and the lengths it is grown through. */
export interface BedPlan {
	songs: { secs: number; steps: number[] }[];
}

/** One song of `secs`: drawn at up to 240 s, then extended 240 s at a time. */
function songOf(secs: number, canExtend: boolean): { secs: number; steps: number[] } {
	if (!canExtend || secs <= MAX_SONG_SECONDS) return { secs, steps: [secs] };
	const steps = [MAX_SONG_SECONDS];
	while (steps[steps.length - 1] < secs) {
		steps.push(Math.min(secs, steps[steps.length - 1] + MAX_EXTEND_SECONDS));
	}
	return { secs, steps };
}

/** The songs a bed `secs` long is made of. */
export function planBed(secs: number, canExtend: boolean): BedPlan {
	const most = canExtend ? MAX_EXTENDED_SECONDS : MAX_SONG_SECONDS;
	const target = Math.max(1, Math.ceil(secs));
	const n = Math.ceil(target / most);
	if (n <= 1) return { songs: [songOf(target, canExtend)] };
	// n songs whose crossfades overlap: together they cover the bed exactly.
	const each = Math.ceil((target + SONG_CROSSFADE_SECONDS * (n - 1)) / n);
	return { songs: Array.from({ length: n }, () => songOf(each, canExtend)) };
}

/** What the stage reaches outside itself for. Paths are relative to the episode folder. */
export interface SoundDeps {
	/** The music model can repaint (extend) a song. */
	canExtend: boolean;
	/** Make a song; its hash in the audio cache and its measured length. */
	song(req: MusicRequest): Promise<{ hash: string; secs: number }>;
	speak(text: string, voice: string | undefined): Promise<{ hash: string; secs: number }>;
	save(hash: string, rel: string): Promise<void>;
	join(parts: string[], crossfadeSecs: number, out: string): Promise<void>;
	exists(rel: string): Promise<boolean>;
	saveProgress(): Promise<void>;
	status(text: string): void;
	seed(): number;
}

export interface SoundRun {
	spec: SequenceSpec;
	/** Each section's start and end in the cut. */
	sections: Record<string, { start: number; end: number }>;
	/** Each bed's and line's key. */
	keys: { music: Record<string, string>; narration: Record<string, string> };
	music: Record<string, FileProgress>;
	narration: Record<string, FileProgress>;
}

export interface SoundMade {
	beds: { id: string; file: string; start: number; secs: number }[];
	lines: { id: string; file: string; at: number }[];
	made: number;
}

/** Where a bed starts and how long it lasts in the cut. */
export function bedSpan(
	bed: MusicBed,
	sections: SoundRun['sections']
): { start: number; secs: number } {
	const spans = bed.sections.map((id) => sections[id]).filter(Boolean);
	const start = Math.min(...spans.map((s) => s.start));
	const end = Math.max(...spans.map((s) => s.end));
	return { start, secs: Math.max(1, end - start) };
}

/** A narration line's id in the progress file. */
export const lineId = (section: string, n: number) => `${section}-${n}`;

async function makeBed(bed: MusicBed, secs: number, deps: SoundDeps): Promise<string> {
	const plan = planBed(secs, deps.canExtend);
	const parts: string[] = [];
	for (const [k, song] of plan.songs.entries()) {
		const seed = deps.seed();
		const base: MusicRequest = {
			title: plan.songs.length > 1 ? `${bed.id} ${k + 1}` : bed.id,
			caption: bed.caption,
			instrumental: true,
			durationSec: song.steps[0],
			seed,
			format: 'mp3'
		};
		deps.status(`Music ${bed.id}: song ${k + 1} of ${plan.songs.length}, ${song.steps[0]} s`);
		let made = await deps.song(base);
		for (const target of song.steps.slice(1)) {
			deps.status(`Music ${bed.id}: extending song ${k + 1} to ${target} s`);
			made = await deps.song({
				...base,
				task: 'repaint',
				source: { name: `${bed.id}.mp3`, hash: made.hash },
				...extendFields(made.secs, target - made.secs)
			});
		}
		const file = plan.songs.length > 1 ? `music/${bed.id}-${k + 1}.mp3` : `music/${bed.id}.mp3`;
		await deps.save(made.hash, file);
		parts.push(file);
	}
	if (parts.length === 1) return parts[0];
	const out = `music/${bed.id}.wav`;
	await deps.join(parts, SONG_CROSSFADE_SECONDS, out);
	return out;
}

async function isDone(
	was: FileProgress | undefined,
	key: string,
	deps: SoundDeps
): Promise<boolean> {
	return !!was && was.status === 'done' && was.key === key && !!was.file && deps.exists(was.file);
}

/** Make what is missing of the beds and lines; where each is and starts. */
export async function makeSound(run: SoundRun, deps: SoundDeps): Promise<SoundMade> {
	const out: SoundMade = { beds: [], lines: [], made: 0 };
	for (const bed of run.spec.sound.music) {
		const span = bedSpan(bed, run.sections);
		const key = run.keys.music[bed.id];
		const was = run.music[bed.id];
		if (!(await isDone(was, key, deps))) {
			const file = await makeBed(bed, span.secs, deps);
			run.music[bed.id] = { key, status: 'done', file };
			await deps.saveProgress();
			out.made++;
		}
		out.beds.push({ id: bed.id, file: run.music[bed.id].file!, ...span });
	}
	for (const [i, line] of run.spec.sound.narration.entries()) {
		const id = lineId(line.section, i + 1);
		const key = run.keys.narration[id];
		if (!(await isDone(run.narration[id], key, deps))) {
			deps.status(`Narration ${i + 1} of ${run.spec.sound.narration.length}`);
			const spoken = await deps.speak(line.text, line.voice);
			const file = `narration/${id}.wav`;
			await deps.save(spoken.hash, file);
			run.narration[id] = { key, status: 'done', file };
			await deps.saveProgress();
			out.made++;
		}
		const start = run.sections[line.section]?.start ?? 0;
		out.lines.push({ id, file: run.narration[id].file!, at: start + line.at_secs });
	}
	return out;
}
