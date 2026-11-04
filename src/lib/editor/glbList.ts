/**
 * The 3D viewer's list of models: every GLB under the editor window's
 * folder (`editor_list_glb`), and stepping through them with ← / →.
 */

/** A file the 3D models job kept from an earlier try (`attempts/create-NN/`). */
export function isAttempt(relPath: string): boolean {
	return /(^|\/)attempts\//.test(relPath);
}

/** The models to list: attempts only when asked for, and always the one showing. */
export function visibleModels(files: string[], current: string, attempts: boolean): string[] {
	return files.filter((f) => f === current || attempts || !isAttempt(f));
}

/** The model `delta` steps from `current`, wrapping round; null when there is nowhere to go. */
export function stepModel(list: string[], current: string, delta: number): string | null {
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
