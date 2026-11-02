/**
 * Files a turn wrote, so the turn may write one again to revise it.
 *
 * The repeat-write guard (`resolveWritePathInteractive`) refuses a second
 * write to a path in one turn, because a model writing a long file as several
 * calls kept only the last one. A revision is different: a model that read
 * back its PDF and found it a page too long writes the whole document again.
 * Each format says what a revision keeps and a continuation doesn't — a
 * document its title, a spreadsheet its header and first record. The rule is
 * for a file the turn created; one that was there before the turn is still
 * refused. Slide decks have their own, which also keeps a deck's look
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
	/** The file did not exist before the turn wrote it. */
	created: boolean;
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

/** A document is revised when it starts with the same line. */
export const DOCUMENT: DraftKind = {
	keeps: (before, now) => before[0] !== '' && before[0] === now[0],
	how: 'write it whole again starting with the same first line'
};

/** A spreadsheet is revised when its first sheet keeps its header and first record. */
export const SPREADSHEET: DraftKind = {
	keeps: (before, now) =>
		before.length > 0 && before.every((s) => s !== '') && before.join('\n') === now.join('\n'),
	how: 'write it whole again with the same header row and first data row'
};

/** The file at `path`, when the turn created it and it has rewrites left. */
function revisable(turn: Set<string>, path: string): Draft | undefined {
	const draft = drafts.get(turn)?.get(path);
	return draft?.created && draft.rewrites < MAX_DRAFT_REWRITES ? draft : undefined;
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
	overwrite: boolean
): void {
	const map = turnMap(turn);
	const seen = map.get(path);
	map.set(path, {
		signature,
		created: seen ? seen.created : !overwrite,
		rewrites: seen ? seen.rewrites + 1 : 0
	});
}

/**
 * What a refused repeat write of the file at `path` adds: how to revise it,
 * while the turn created it and it has rewrites left. Empty otherwise.
 */
export function draftRewriteHint(turn: Set<string>, path: string, kind: DraftKind): string {
	if (!revisable(turn, path)) return '';
	return `To revise a file you created this turn, ${kind.how}. `;
}
