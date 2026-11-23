/**
 * The Speech stage: every speaking section's lines spoken into
 * `narration/<section>-line-NN.wav`, with their lengths and pauses, before
 * the clip plan is built from them; then each speaking window's slice of
 * the speech joined into `narration/<section>-win-NN.wav`.
 *
 * A line already spoken, whose file is there and whose text and voice are
 * unchanged, isn't spoken again, so a re-run gets the same lengths and the
 * same windows. A window's WAV is joined again only when its parts changed.
 */
import type { ClipPlan, GenerateItem } from '#lib/sequence/spec/plan.ts';
import { lineFile, type LineSpeech } from '#lib/sequence/spec/speaking.ts';
import { partsKey, type SequenceProgress } from '#lib/sequence/spec/progress.ts';
import type { SequenceSpec, SpeakingSection } from '#lib/sequence/spec/types.ts';

/** What the stage reaches outside itself for. Paths are relative to the episode folder. */
export interface SpeechDeps {
	/** Speak a line into the audio cache: its hash and length. */
	speak(text: string, voice: string | undefined): Promise<{ hash: string; secs: number }>;
	save(hash: string, rel: string): Promise<void>;
	exists(rel: string): Promise<boolean>;
	silences(rel: string): Promise<{ start: number; end: number }[]>;
	/** Join stretches of files into `out`. */
	join(parts: { path: string; from_secs: number; to_secs: number }[], out: string): Promise<void>;
	saveProgress(): Promise<void>;
	status(text: string): void;
}

export const speakingSections = (spec: SequenceSpec): SpeakingSection[] =>
	spec.sections.filter((s): s is SpeakingSection => s.kind === 'speaking');

/** Speak what isn't spoken yet; how many lines were spoken now. */
export async function speakLines(
	spec: SequenceSpec,
	progress: SequenceProgress,
	deps: SpeechDeps
): Promise<number> {
	const speech = (progress.speech ??= {});
	const lines = speakingSections(spec).flatMap((s) =>
		s.lines.map((line, i) => ({ s, line, file: lineFile(s.id, i + 1) }))
	);
	let spoken = 0;
	for (const [k, { line, file }] of lines.entries()) {
		const voice = line.voice ?? '';
		const was = speech[line.id];
		if (was && was.text === line.text && was.voice === voice && (await deps.exists(was.file))) {
			continue;
		}
		deps.status(`Speaking line ${k + 1} of ${lines.length}`);
		const made = await deps.speak(line.text, line.voice);
		await deps.save(made.hash, file);
		const silences = await deps.silences(file);
		speech[line.id] = { file, secs: made.secs, hash: made.hash, text: line.text, voice, silences };
		await deps.saveProgress();
		spoken++;
	}
	return spoken;
}

/** The spoken lines as the plan takes them. */
export function speechMap(progress: SequenceProgress): Record<string, LineSpeech> {
	return Object.fromEntries(
		Object.entries(progress.speech ?? {}).map(([id, l]) => [
			id,
			{ file: l.file, secs: l.secs, hash: l.hash, silences: l.silences }
		])
	);
}

/** Join each window's speech that isn't joined from these parts yet; how many were joined now. */
export async function joinWindows(
	plan: ClipPlan,
	progress: SequenceProgress,
	deps: SpeechDeps
): Promise<number> {
	const windows = (progress.windows ??= {});
	const items = plan.items.filter((i): i is GenerateItem => i.kind === 'generate' && !!i.audio);
	let joined = 0;
	for (const item of items) {
		const audio = item.audio!;
		const key = partsKey(audio.parts);
		const was = windows[item.id];
		if (was && was.parts_key === key && was.file === audio.out && (await deps.exists(was.file))) {
			continue;
		}
		const parts = audio.parts.map((p) => ({
			path: p.file,
			from_secs: p.from_secs,
			to_secs: p.to_secs
		}));
		await deps.join(parts, audio.out);
		windows[item.id] = { file: audio.out, parts_key: key };
		await deps.saveProgress();
		joined++;
	}
	return joined;
}
