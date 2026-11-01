/**
 * Documents a turn wrote, so the turn may write one again to revise it.
 *
 * The repeat-write guard (`resolveWritePathInteractive`) refuses a second
 * write to a path in one turn, because a model writing a long document as
 * several calls kept only the last one. A revision is different: a model that
 * read back its PDF and found it a page too long writes the whole document
 * again under the same title. A chunk carries on from where the last one
 * stopped, so it doesn't start with the title. The rule is for a document the
 * turn created; one that was there before the turn is still refused.
 */

/** Rewrites one document may have in a turn. */
export const MAX_DOCUMENT_REWRITES = 3;

interface Draft {
	/** The first line of its content, normalised (`firstLine`). */
	title: string;
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

/** The first non-blank line, without its heading marks, in lower case. */
function firstLine(content: string): string {
	const line = content.split('\n').find((l) => l.trim() !== '') ?? '';
	return line
		.replace(/^\s*#+\s*/, '')
		.trim()
		.toLowerCase();
}

/** The document at `path`, when the turn created it and it has rewrites left. */
function revisable(turn: Set<string>, path: string): Draft | undefined {
	const draft = drafts.get(turn)?.get(path);
	return draft?.created && draft.rewrites < MAX_DOCUMENT_REWRITES ? draft : undefined;
}

/**
 * Whether `content` may replace the document this turn wrote at `path`: the
 * turn created it, it has rewrites left, and `content` starts with its title.
 */
export function mayRewriteDocument(turn: Set<string>, path: string, content: string): boolean {
	const draft = revisable(turn, path);
	return draft !== undefined && draft.title !== '' && firstLine(content) === draft.title;
}

/**
 * Note a document written at `path`. `overwrite` is whether the write replaced
 * a file; on a rewrite the turn's own earlier write is what it replaced.
 */
export function noteDocument(
	turn: Set<string>,
	path: string,
	content: string,
	overwrite: boolean
): void {
	const map = turnMap(turn);
	const seen = map.get(path);
	map.set(path, {
		title: firstLine(content),
		created: seen ? seen.created : !overwrite,
		rewrites: seen ? seen.rewrites + 1 : 0
	});
}

/**
 * What a refused repeat write of the document at `path` adds: how to revise
 * it, while the turn created it and it has rewrites left. Empty otherwise.
 */
export function documentRewriteHint(turn: Set<string>, path: string): string {
	if (!revisable(turn, path)) return '';
	return (
		`To revise a document you created this turn, write it whole again starting ` +
		`with the same first line. `
	);
}
