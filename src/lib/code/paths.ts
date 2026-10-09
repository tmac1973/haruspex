/**
 * File paths in a Code session: which are inside its folder, and which bits
 * of text name one (`src/app.ts:42`). Only a path inside the folder is ever
 * a link or an editor target; the folder is the session's boundary.
 *
 * Lexical only — nothing here touches the disk, so a symlink inside the folder
 * that points out of it still counts as inside. The editor reads through
 * `fs_read_text_full`, which applies the working directory's own checks.
 */

/** Forward slashes, no trailing slash. */
function clean(path: string): string {
	return path.replace(/\\/g, '/').replace(/\/+$/, '');
}

/**
 * `path` relative to `root`, or null when it is outside it (or is the folder
 * itself). Relative paths are taken from the folder; `.` and `..` are
 * resolved first, so `src/../../etc/passwd` is outside.
 */
export function relativeToRoot(root: string, path: string): string | null {
	const base = clean(root);
	const p = path.trim().replace(/\\/g, '/');
	if (!base || !p || p.startsWith('~')) return null;
	const absolute = p.startsWith('/') || /^[a-z]:\//i.test(p);
	const parts: string[] = [];
	for (const seg of (absolute ? p : `${base}/${p}`).split('/')) {
		if (seg === '' || seg === '.') continue;
		if (seg === '..') {
			if (parts.length === 0) return null;
			parts.pop();
		} else parts.push(seg);
	}
	const lead = base.startsWith('/') ? '/' : '';
	const full = lead + parts.join('/');
	const prefix = base.endsWith('/') ? base : `${base}/`;
	if (!full.startsWith(prefix)) return null;
	const rel = full.slice(prefix.length);
	return rel || null;
}

export interface PathRef {
	path: string;
	/** 1-based, when the text gave one. */
	line: number | null;
}

/** A path, optionally with `:line` or `:line:column`. */
const PATH_REF = /^((?:\.{1,2}\/|\/)?[\w@+-][\w@.+-]*(?:\/[\w@.+-]+)*)(?::(\d+)(?::\d+)?)?$/;

/**
 * Read `text` as a file reference, or null when it doesn't look like one.
 * Conservative, because a false link is worse than a missing one: it needs a
 * slash or a line number, and its last part needs a file extension unless a
 * line number vouches for it. `Node.js`, `and/or`, `12:30` and `src/lib` are
 * not references; `src/app.ts`, `app.ts:42` and `src/Makefile:3` are.
 */
export function parsePathRef(text: string): PathRef | null {
	const m = PATH_REF.exec(text.trim());
	if (!m) return null;
	const path = m[1];
	const line = m[2] ? Number(m[2]) : null;
	const last = path.split('/').pop() ?? '';
	const hasExt = /\.[A-Za-z][\w-]{0,9}$/.test(last) && !last.startsWith('.');
	const dotfile = /^\.[\w-]+$/.test(last);
	if (!/[A-Za-z]/.test(last)) return null;
	if (!path.includes('/') && line === null) return null;
	if (!path.includes('/') && !hasExt) return null;
	if (line === null && !hasExt && !dotfile) return null;
	if (line === 0) return null;
	return { path, line };
}

/** Turns text into a link target in one session's folder, or null. */
export type CodePathLinker = (text: string) => PathRef | null;

/** References inside `root`, with the path made relative to it. */
export function makeCodePathLinker(root: string): CodePathLinker {
	return (text) => {
		const ref = parsePathRef(text);
		if (!ref) return null;
		const rel = relativeToRoot(root, ref.path);
		return rel ? { path: rel, line: ref.line } : null;
	};
}

export interface GrepLinePart {
	/** The path as printed. */
	path: string;
	line: number | null;
	/** What follows the location: `:12: text`, `: 3` (a count), or nothing. */
	rest: string;
}

/**
 * Split one line of `code_grep` output into its file and the rest: a match
 * (`path:12: text`), a context line (`path-12: text`), a count (`path: 3`) or
 * a bare file (`path`). Null for anything else, such as the truncation note.
 */
export function splitGrepLine(text: string): GrepLinePart | null {
	const hit = /^(.+?)([:-])(\d+): /.exec(text);
	if (hit) return { path: hit[1], line: Number(hit[3]), rest: text.slice(hit[1].length) };
	const count = /^(.+?): \d+$/.exec(text);
	if (count) return { path: count[1], line: null, rest: text.slice(count[1].length) };
	if (/^[^\s:]+$/.test(text) && /[/.]/.test(text)) return { path: text, line: null, rest: '' };
	return null;
}
