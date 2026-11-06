/**
 * An editor window's file list: every model, image, sound and text file under
 * its folder (`editor_list_files`), one kind at a time, as a tree of folders
 * stepped through with the arrow keys.
 */

import { viewerFor, type FileViewer } from '#lib/editor/document.svelte.ts';

/** What the list shows at once: one viewer's files, or the text files. */
export type ListKind = FileViewer | 'text';

/** The kinds, in the order the list offers them. */
export const KINDS: { kind: ListKind; label: string }[] = [
	{ kind: 'glb', label: '3D' },
	{ kind: 'image', label: 'Images' },
	{ kind: 'audio', label: 'Audio' },
	{ kind: 'text', label: 'Text' }
];

/** Anything without a viewer opens as text. */
export function kindOf(relPath: string): ListKind {
	return viewerFor(relPath) ?? 'text';
}

/** A file the 3D models job kept from an earlier try (`attempts/create-NN/`). */
export function isAttempt(relPath: string): boolean {
	return /(^|\/)attempts\//.test(relPath);
}

const collator = new Intl.Collator(undefined, { numeric: true });

/** Tree order: in each folder, its folders first, then its files, by name. */
export function compareTree(a: string, b: string): number {
	const pa = a.split('/');
	const pb = b.split('/');
	for (let i = 0; i < Math.min(pa.length, pb.length); i++) {
		const fileA = i === pa.length - 1;
		const fileB = i === pb.length - 1;
		if (fileA !== fileB) return fileA ? 1 : -1;
		const c = collator.compare(pa[i], pb[i]);
		if (c !== 0) return c;
	}
	return pa.length - pb.length;
}

/**
 * The files of `kind` to list, in tree order: attempts only when asked for,
 * and always the one showing.
 */
export function visibleFiles(
	files: string[],
	current: string,
	kind: ListKind,
	attempts: boolean
): string[] {
	return files
		.filter((f) => f === current || (kindOf(f) === kind && (attempts || !isAttempt(f))))
		.sort(compareTree);
}

/** How many files of each kind there are, attempts left out unless asked for. */
export function countKinds(files: string[], attempts: boolean): Map<ListKind, number> {
	const counts = new Map<ListKind, number>();
	for (const f of files) {
		const kind = kindOf(f);
		if (attempts || !isAttempt(f)) counts.set(kind, (counts.get(kind) ?? 0) + 1);
	}
	return counts;
}

/** The file to open first in a folder: the first of the first kind it has. */
export function firstFile(files: string[]): string | null {
	for (const { kind } of KINDS) {
		const found = visibleFiles(files, '', kind, false)[0] ?? visibleFiles(files, '', kind, true)[0];
		if (found) return found;
	}
	return null;
}

/** The file `delta` steps from `current`, wrapping round; null when there is nowhere to go. */
export function stepFile(list: string[], current: string, delta: number): string | null {
	if (list.length < 2) return null;
	const i = list.indexOf(current);
	const from = i < 0 ? (delta > 0 ? -1 : 0) : i;
	return list[(((from + delta) % list.length) + list.length) % list.length];
}

/** The folders a file is in, outermost first: `a/b/c.png` → `['a/', 'a/b/']`. */
export function ancestors(relPath: string): string[] {
	const parts = relPath.split('/').slice(0, -1);
	return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
}

/** One line of the tree. A folder's `path` ends in `/`. */
export type TreeRow = { dir: boolean; path: string; name: string; depth: number };

/**
 * The lines to show for `files` (in tree order): each folder once, before
 * what it holds, and nothing inside a folder in `collapsed`.
 */
export function treeRows(files: string[], collapsed: ReadonlySet<string>): TreeRow[] {
	const rows: TreeRow[] = [];
	let open: string[] = [];
	for (const file of files) {
		const dirs = ancestors(file);
		let shared = 0;
		while (shared < dirs.length && dirs[shared] === open[shared]) shared++;
		for (let depth = shared; depth < dirs.length; depth++) {
			if (dirs.slice(0, depth).some((d) => collapsed.has(d))) break;
			const path = dirs[depth];
			rows.push({ dir: true, path, name: path.slice(0, -1).split('/').pop()!, depth });
		}
		open = dirs;
		if (dirs.some((d) => collapsed.has(d))) continue;
		rows.push({ dir: false, path: file, name: file.split('/').pop()!, depth: dirs.length });
	}
	return rows;
}
