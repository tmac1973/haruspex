/**
 * Files a turn wrote, so the turn may write one again to revise it.
 *
 * The repeat-write guard (`resolveWritePathInteractive`) refuses a second
 * write to a path in one turn, because a model writing a long file as several
 * calls kept only the last one. A revision is different: a model that read
 * back its PDF and found it a page too long writes the whole document again.
 * Each format says what a revision keeps and a continuation doesn't — a
 * document its title, a spreadsheet its header and first record. The rule is
 * for a file the turn created, or a PDF the model was shown
 * (`documents/preview.ts`); one that was there before the turn and wasn't
 * shown is still refused. Text files outside a Code session use the document rule (`fs-write.ts`).
 * Slide decks have their own, which also keeps a deck's look
 * (`slides/preview.ts`).
 */

/** Rewrites one file may have in a turn. */
export const MAX_DRAFT_REWRITES = 3;

/**
 * What a format compares between writes: `signature` turns content into a
 * few normalised strings, and `keeps` says whether the new ones are a
 * revision of the old.
 */
export interface DraftKind {
	keeps: (before: string[], now: string[]) => boolean;
	/** How to write a revision, said when a repeat write is refused. */
	how: string;
}

interface Draft {
	signature: string[];
	/** How the signature compares; absent for a draft noted without one. */
	kind?: DraftKind;
	/** The file did not exist before the turn wrote it. */
	created: boolean;
	/** The model was shown it, so a rewrite fixes what it saw. */
	previewed: boolean;
	rewrites: number;
}

const drafts = new WeakMap<Set<string>, Map<string, Draft>>();

function turnMap(turn: Set<string>): Map<string, Draft> {
	let map = drafts.get(turn);
	if (!map) {
		map = new Map();
		drafts.set(turn, map);
	}
	return map;
}

/** A value as a signature compares it: trimmed and in lower case. */
export function normText(value: unknown): string {
	const text = typeof value === 'string' ? value : JSON.stringify(value ?? '');
	return text.trim().toLowerCase();
}

/** The first non-blank line, without its heading marks: a document's title. */
export function firstLine(content: string): string {
	const line = content.split('\n').find((l) => l.trim() !== '') ?? '';
	return normText(line.replace(/^\s*#+\s*/, ''));
}

/** Lines shorter than this, once trimmed, say little about which file they are in. */
const TEXT_LINE_MIN = 8;
/** The share of the earlier write's lines a revision keeps. */
const TEXT_KEEPS = 0.5;

/**
 * A text file's signature: its first line, then its distinct lines of some
 * length. A short `}` or `return x` is in every part of a long file.
 */
export function textSignature(content: string): string[] {
	const lines = new Set<string>();
	for (const line of content.split('\n')) {
		const t = line.trim();
		if (t.length >= TEXT_LINE_MIN) lines.add(t);
	}
	return [firstLine(content), ...lines];
}

/**
 * A text file is revised when it starts with the same line, or keeps at
 * least half the earlier write's lines. The first line alone refused most
 * revisions of source code, whose first edit is often to its imports
 * (#1116); a second part of a long file shares few lines with the first.
 */
export const TEXT: DraftKind = {
	keeps: (before, now) => {
		if (before[0] !== '' && before[0] === now[0]) return true;
		const lines = before.slice(1);
		if (lines.length === 0) return false;
		const kept = new Set(now.slice(1));
		return lines.filter((l) => kept.has(l)).length >= lines.length * TEXT_KEEPS;
	},
	how: 'write it whole again, keeping its first line or most of its lines'
};

/**
 * A built document (PDF, Word, LibreOffice) is revised when it keeps its
 * title, its first heading or its first line. Fixing a layout often means
 * rewording an opening paragraph, so the line alone is too strict; a later
 * part, written as a second call, starts at a later heading.
 */
export const BUILT_DOCUMENT: DraftKind = {
	keeps: (before, now) => before.some((s, i) => s !== '' && s === now[i]),
	how: 'write it whole again with the same title, first heading or first line'
};

/** What a revised built document keeps: its title, first heading and first line. */
export function documentSignature(content: string, title: unknown): string[] {
	const heading = content.split('\n').find((l) => /^\s*#{1,6}\s/.test(l)) ?? '';
	return [typeof title === 'string' ? normText(title) : '', firstLine(heading), firstLine(content)];
}

/** A spreadsheet is revised when its first sheet keeps its header and first record. */
export const SPREADSHEET: DraftKind = {
	keeps: (before, now) =>
		before.length > 0 && before.every((s) => s !== '') && before.join('\n') === now.join('\n'),
	how: 'write it whole again with the same header row and first data row'
};

/** The file at `path`, when the turn created it or showed it to the model,
 *  and it has rewrites left. */
function revisable(turn: Set<string>, path: string): Draft | undefined {
	const draft = drafts.get(turn)?.get(path);
	if (!draft || !(draft.created || draft.previewed)) return undefined;
	return draft.rewrites < MAX_DRAFT_REWRITES ? draft : undefined;
}

/** Whether the file at `path` may still be rewritten this turn. */
export function canRewriteDraft(turn: Set<string>, path: string): boolean {
	return revisable(turn, path) !== undefined;
}

/** Note that the model was shown the file at `path`, as written. */
export function noteDraftPreview(turn: Set<string>, path: string): void {
	const draft = drafts.get(turn)?.get(path);
	if (draft) draft.previewed = true;
}

/** Whether a write with this `signature` may replace the file this turn wrote at `path`. */
export function mayRewriteDraft(
	turn: Set<string>,
	path: string,
	signature: string[],
	kind: DraftKind
): boolean {
	const draft = revisable(turn, path);
	return draft !== undefined && kind.keeps(draft.signature, signature);
}

/**
 * Note a file written at `path`. `overwrite` is whether the write replaced a
 * file; on a rewrite the turn's own earlier write is what it replaced.
 */
export function noteDraft(
	turn: Set<string>,
	path: string,
	signature: string[],
	overwrite: boolean,
	kind?: DraftKind
): void {
	const map = turnMap(turn);
	const seen = map.get(path);
	map.set(path, {
		signature,
		kind,
		created: seen ? seen.created : !overwrite,
		previewed: seen?.previewed ?? false,
		rewrites: seen ? seen.rewrites + 1 : carriedRewrites(map, signature, kind)
	});
}

/**
 * The rewrites a new file inherits when it is the same document as one the
 * turn already wrote under another name. Seen live: a model out of rewrites on
 * summary.pdf wrote summary-2.pdf four times and summary-3.pdf three times.
 */
function carriedRewrites(map: Map<string, Draft>, signature: string[], kind?: DraftKind): number {
	if (!kind) return 0;
	let most = -1;
	for (const d of map.values()) {
		if (d.kind === kind && kind.keeps(d.signature, signature)) most = Math.max(most, d.rewrites);
	}
	return most + 1;
}

/**
 * What a refused repeat write of the file at `path` adds: how to revise it,
 * while the turn created it and it has rewrites left. Empty otherwise.
 */
export function draftRewriteHint(turn: Set<string>, path: string, kind: DraftKind): string {
	const draft = drafts.get(turn)?.get(path);
	if (draft && (draft.created || draft.previewed) && draft.rewrites >= MAX_DRAFT_REWRITES) {
		// Offering a new name here let a turn rewrite the same document without end.
		return (
			`It has been rewritten as many times as it can be this turn. Don't write it ` +
			`again under another name: tell the user what still needs fixing. `
		);
	}
	if (!revisable(turn, path)) return '';
	return (
		`This write starts differently from the one before, so it was taken for a ` +
		`second part rather than a revision. To revise a file you created or were ` +
		`shown this turn, ${kind.how}. `
	);
}
