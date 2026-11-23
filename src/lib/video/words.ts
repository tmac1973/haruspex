/**
 * A transcript's words with their times, for cutting on a word: the stretch
 * asked for, one word per line, to a hundredth of a second.
 */
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';
import { parseTime } from '#lib/video/args.ts';

/** The stretch of a clip to list words from, in its own time. */
export interface WordStretch {
	from: number;
	to: number;
}

/** At most this many words in one answer; past it, the list says where to go on. */
export const WORD_CAP = 600;

/** `{ from, to }` from the tool's argument, or an error; null when it is not given. */
export function parseWordStretch(v: unknown): WordStretch | string | null {
	if (v === undefined || v === null) return null;
	if (typeof v !== 'object') return '"words" is { "from": "1:02", "to": "1:30" }.';
	const o = v as Record<string, unknown>;
	const from = parseTime(o.from) ?? 0;
	const to = o.to === undefined ? Infinity : parseTime(o.to);
	if (to === null || to <= from) return '"words" needs "to" after "from", e.g. "1:02" to "1:30".';
	return { from, to };
}

/** `1:02.35`: minutes, seconds and hundredths. */
export function wordTime(secs: number): string {
	const hundredths = Math.max(0, Math.round(secs * 100));
	const m = Math.floor(hundredths / 6000);
	const s = (hundredths % 6000) / 100;
	return `${m}:${s.toFixed(2).padStart(5, '0')}`;
}

/** Each transcript's words that start inside `stretch`, one a line. */
export function wordsReport(list: Transcript[], stretch: WordStretch, cap = WORD_CAP): string {
	const out: string[] = [];
	let n = 0;
	for (const t of list) {
		const words = t.segments.flatMap((s) => s.words);
		const end = Number.isFinite(stretch.to) ? wordTime(stretch.to) : 'the end';
		out.push(`${t.path}, words from ${wordTime(stretch.from)} to ${end} (start–end, text):`);
		if (words.length === 0) {
			out.push('Whisper gave no word times for it.', '');
			continue;
		}
		const inside = words.filter((w) => w.start >= stretch.from - 0.005 && w.start < stretch.to);
		for (const w of inside) {
			if (n === cap) {
				out.push(`… (stopped at ${cap} words; ask again with words.from "${wordTime(w.start)}")`);
				return out.join('\n').trim();
			}
			out.push(`${wordTime(w.start)}–${wordTime(w.end)} ${w.text}`);
			n++;
		}
		if (inside.length === 0) out.push('No words in that stretch.');
		out.push('');
	}
	return out.join('\n').trim();
}
