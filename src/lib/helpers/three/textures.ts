/**
 * `kit.texture('<path>')`: a build module's PNGs. The sandboxed page has an
 * opaque origin and can't read project files, so `check_3d` finds every
 * literal path in the module sources, reads those PNGs first and hands them
 * to the page as data URLs (`runModule.ts`).
 */

/** The most PNGs one run may use. */
export const MAX_TEXTURES = 8;
/** The largest PNG a module may use. */
export const MAX_TEXTURE_BYTES = 4 * 1024 * 1024;

const CALL = /kit\.texture\(\s*(['"])([^'"\n]+)\1\s*\)/g;

/** The literal paths a source passes to `kit.texture`, each once, in order. */
export function textureRefs(source: string): string[] {
	const seen = new Set<string>();
	for (const m of source.matchAll(CALL)) seen.add(m[2]);
	return [...seen];
}

/**
 * `ref` joined to the module's folder `dir` (`''` for the working folder),
 * with `.` and `..` folded away; null when `ref` is absolute or climbs out of
 * the top of `dir`.
 */
export function texturePath(dir: string, ref: string): string | null {
	if (/^([/\\]|[A-Za-z]:)/.test(ref)) return null;
	const root = /^[/\\]/.test(dir) ? '/' : '';
	const parts: string[] = [];
	for (const p of [...dir.split(/[/\\]+/), ...ref.split(/[/\\]+/)]) {
		if (p === '' || p === '.') continue;
		if (p !== '..') parts.push(p);
		else if (!parts.pop()) return null;
	}
	return root + parts.join('/');
}
