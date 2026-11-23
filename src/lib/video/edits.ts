/**
 * A clip's speech edit list: what the transcript viewer marks and the
 * `fix-speech` skill applies. Words struck out to cut, and spans retyped to
 * say something else in the speaker's saved voice. The viewer only writes
 * this list, beside the clip's transcript
 * (`<episode>/.haruspex/edits/<clip stem>.edits.json`); the clip and the
 * project are never touched here.
 *
 * Times are in the clip's own seconds. The newest edit owns its words: a
 * cut over cuts joins them, and anything else under a new edit is trimmed
 * away (a cut keeps its parts either side; a replace under it goes).
 */
import type { Transcript } from '#lib/ipc/gen/Transcript.ts';
import type { Word } from '#lib/ipc/gen/Word.ts';

export interface CutEdit {
	id: string;
	kind: 'cut';
	from: number;
	to: number;
	/** The words cut, as said. */
	words: string;
}

export interface ReplaceEdit {
	id: string;
	kind: 'replace';
	from: number;
	to: number;
	old: string;
	new: string;
	/**
	 * How the new words fit the gap: `fit` speeds them to the old length,
	 * `cut` lets the picture shorten or lengthen, `auto` lets the skill pick.
	 */
	mode: 'auto' | 'fit' | 'cut';
	/** A saved voice for this one; the list's own otherwise. */
	voice?: string;
}

export type Edit = CutEdit | ReplaceEdit;

export interface SpeechEdits {
	version: 1;
	/**
	 * The clip, relative to the episode folder whose `.haruspex/edits/` holds
	 * this list, so it is found from wherever the list is read.
	 */
	clip: string;
	/** `transcriptHash` of the transcript the edits were made on. */
	transcript_hash: string;
	/** The saved voice replacements speak in. */
	voice?: string;
	edits: Edit[];
	/** Ids of edits already applied. */
	done: string[];
}

/** Every word of a transcript, in order. */
export function wordsOf(t: Transcript): Word[] {
	return t.segments.flatMap((s) => s.words);
}

/** The SHA-256 of the transcript's words (text, start, end) as JSON, in hex. */
export async function transcriptHash(t: Transcript): Promise<string> {
	const json = JSON.stringify(wordsOf(t).map((w) => [w.text, w.start, w.end]));
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(json));
	return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Whether the edits were made on another version of the transcript. */
export function stale(edits: SpeechEdits, hash: string): boolean {
	return edits.transcript_hash !== hash;
}

export function emptyEdits(clip: string, hash: string): SpeechEdits {
	return { version: 1, clip, transcript_hash: hash, edits: [], done: [] };
}

/** The edit list in a file's text, or null when it isn't one. */
export function parseEdits(text: string): SpeechEdits | null {
	try {
		const v = JSON.parse(text) as Partial<SpeechEdits>;
		if (v.version !== 1 || typeof v.clip !== 'string' || !Array.isArray(v.edits)) return null;
		return {
			version: 1,
			clip: v.clip,
			transcript_hash: String(v.transcript_hash ?? ''),
			...(v.voice ? { voice: v.voice } : {}),
			edits: v.edits,
			done: Array.isArray(v.done) ? v.done : []
		};
	} catch {
		return null;
	}
}

let counter = 0;
export function newId(): string {
	return `e${Date.now().toString(36)}${(++counter).toString(36)}`;
}

/** Indexes of the words whose middle lies in `from`–`to`. */
function indexesIn(words: Word[], from: number, to: number): number[] {
	return words.flatMap((w, i) => {
		const mid = (w.start + w.end) / 2;
		return mid >= from - 1e-6 && mid <= to + 1e-6 ? [i] : [];
	});
}

/** Runs of consecutive indexes: [1,2,4] → [[1,2],[4]]. */
function runs(ix: number[]): number[][] {
	const out: number[][] = [];
	for (const i of ix) {
		const last = out[out.length - 1];
		if (last && last[last.length - 1] === i - 1) last.push(i);
		else out.push([i]);
	}
	return out;
}

/** A cut of words `ix` (consecutive). */
export function cutOf(words: Word[], ix: number[], id = newId()): CutEdit {
	const a = words[ix[0]];
	const b = words[ix[ix.length - 1]];
	return {
		id,
		kind: 'cut',
		from: a.start,
		to: b.end,
		words: ix.map((i) => words[i].text).join(' ')
	};
}

/** A replace of words `ix` (consecutive) by `text`. */
export function replaceOf(
	words: Word[],
	ix: number[],
	text: string,
	mode: ReplaceEdit['mode'] = 'auto'
): ReplaceEdit {
	const a = words[ix[0]];
	const b = words[ix[ix.length - 1]];
	return {
		id: newId(),
		kind: 'replace',
		from: a.start,
		to: b.end,
		old: ix.map((i) => words[i].text).join(' '),
		new: text.trim(),
		mode
	};
}

/**
 * The list with `edit` added: it owns its words. A cut joins the cuts it
 * meets or touches; what else it covers is trimmed out of older edits.
 */
export function addEdit(list: Edit[], edit: Edit, words: Word[]): Edit[] {
	let mine = new Set(indexesIn(words, edit.from, edit.to));
	let merged: Edit = edit;
	const out: Edit[] = [];
	for (const e of list) {
		const theirs = indexesIn(words, e.from, e.to);
		const meets =
			theirs.some((i) => mine.has(i)) ||
			(edit.kind === 'cut' &&
				e.kind === 'cut' &&
				theirs.some((i) => mine.has(i - 1) || mine.has(i + 1)));
		if (!meets) {
			out.push(e);
			continue;
		}
		if (edit.kind === 'cut' && e.kind === 'cut') {
			mine = new Set([...mine, ...theirs]);
			merged = cutOf(
				words,
				[...mine].sort((a, b) => a - b),
				merged.id
			);
			continue;
		}
		if (e.kind === 'replace') continue;
		// A cut under a new replace keeps the parts either side of it.
		for (const part of runs(theirs.filter((i) => !mine.has(i)))) out.push(cutOf(words, part));
	}
	return [...out, merged].sort((a, b) => a.from - b.from);
}

/** The list without the edit `id`. */
export function removeEdit(list: Edit[], id: string): Edit[] {
	return list.filter((e) => e.id !== id);
}

/** The edit, if any, that covers word `i`. */
export function editAt(list: Edit[], words: Word[], i: number): Edit | undefined {
	const w = words[i];
	const mid = (w.start + w.end) / 2;
	return list.find((e) => mid >= e.from - 1e-6 && mid <= e.to + 1e-6);
}

/** Where an edit sits in the project now. */
export type MappedEdit =
	| {
			edit: Edit;
			ok: true;
			/** The main-track clip that plays it, from 1. */
			index: number;
			/** In the clip's own time. */
			clipFrom: number;
			clipTo: number;
			/** In the cut's time. */
			cutFrom: number;
			cutTo: number;
			/** How long it lasts in the cut. */
			secs: number;
	  }
	| { edit: Edit; ok: false; problem: string };

/** The fields of a project's main-track clip `mapEdits` reads. */
export interface PlacedClip {
	index: number;
	path: string;
	sourceInSecs: number;
	sourceOutSecs: number;
	startSecs: number;
	speed: number;
}

const samePath = (a: string, b: string) =>
	a.replace(/\\/g, '/').replace(/^\.\//, '') === b.replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Each edit not done yet, on the project's main track: the clip of `clip`
 * (relative to the working folder) that plays all of it. One that two
 * pieces share, or that is cut out already, is a problem, said so.
 */
export function mapEdits(edits: SpeechEdits, clip: string, items: PlacedClip[]): MappedEdit[] {
	const pieces = items.filter((i) => samePath(i.path, clip));
	return edits.edits
		.filter((e) => !edits.done.includes(e.id))
		.map((edit): MappedEdit => {
			const eps = 0.02;
			const holds = pieces.find(
				(p) => p.sourceInSecs <= edit.from + eps && edit.to <= p.sourceOutSecs + eps
			);
			if (holds) {
				const clipFrom = Math.max(edit.from, holds.sourceInSecs);
				const clipTo = Math.min(edit.to, holds.sourceOutSecs);
				const cut = (t: number) => holds.startSecs + (t - holds.sourceInSecs) / holds.speed;
				return {
					edit,
					ok: true,
					index: holds.index,
					clipFrom,
					clipTo,
					cutFrom: cut(clipFrom),
					cutTo: cut(clipTo),
					secs: (clipTo - clipFrom) / holds.speed
				};
			}
			const touched = pieces.filter((p) => p.sourceInSecs < edit.to && edit.from < p.sourceOutSecs);
			const problem =
				pieces.length === 0
					? `${clip} is not on the project's main track.`
					: touched.length > 1
						? `It spans clips ${touched.map((p) => p.index).join(' and ')}; edit each part in the viewer apart.`
						: touched.length === 1
							? `Part of it is cut out of clip ${touched[0].index} already.`
							: 'Those words are cut out of the project already.';
			return { edit, ok: false, problem };
		});
}
