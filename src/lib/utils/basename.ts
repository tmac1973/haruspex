/** The last part of a path, split on `/` or `\`. */
export function basename(path: string): string {
	const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return cut >= 0 ? path.slice(cut + 1) : path;
}
