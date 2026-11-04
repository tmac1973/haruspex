/**
 * An editor window's file list: every model, image and sound under its folder
 * (`editor_list_viewable`), one kind at a time, stepped through with ← / →.
 */

import { viewerFor, type FileViewer } from '#lib/editor/document.svelte.ts';

/** The kinds, in the order the list offers them. */
export const KINDS: { kind: FileViewer; label: string }[] = [
	{ kind: 'glb', label: '3D' },
	{ kind: 'image', label: 'Images' },
	{ kind: 'audio', label: 'Audio' }
];

/** A file the 3D models job kept from an earlier try (`attempts/create-NN/`). */
export function isAttempt(relPath: string): boolean {
	return /(^|\/)attempts\//.test(relPath);
}

/**
 * The files of `kind` to list: attempts only when asked for, and always the
 * one showing.
 */
export function visibleFiles(
	files: string[],
	current: string,
	kind: FileViewer,
	attempts: boolean
): string[] {
	return files.filter(
		(f) => f === current || (viewerFor(f) === kind && (attempts || !isAttempt(f)))
	);
}

/** How many files of each kind there are, attempts left out unless asked for. */
export function countKinds(files: string[], attempts: boolean): Map<FileViewer, number> {
	const counts = new Map<FileViewer, number>();
	for (const f of files) {
		const kind = viewerFor(f);
		if (kind && (attempts || !isAttempt(f))) counts.set(kind, (counts.get(kind) ?? 0) + 1);
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

/** `dir/` and `name` of a relative path, for a two-part label. */
export function splitPath(relPath: string): { dir: string; name: string } {
	const cut = relPath.lastIndexOf('/');
	return cut < 0
		? { dir: '', name: relPath }
		: { dir: relPath.slice(0, cut + 1), name: relPath.slice(cut + 1) };
}
