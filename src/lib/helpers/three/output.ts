/**
 * Which file a `check_3d` call is about, from its arguments alone: shared by
 * the tool (where it writes) and its step card (what the card links to).
 */

export const MODULE_FILE = /\.m?js$/i;
export const MODEL_FILE = /\.(glb|gltf)$/i;

/** Where a build module's GLB goes when the call names no `out`. */
export function defaultGlbPath(modulePath: string): string {
	return modulePath.replace(MODULE_FILE, '.glb');
}

/**
 * The model file a call writes or checks: its `out`, else a module's own
 * `.glb`, else the `.glb`/`.gltf` it was given. Null for arguments that
 * name no such file.
 */
export function check3dFile(args: Record<string, unknown> | undefined): string | null {
	const path = typeof args?.path === 'string' ? args.path.trim() : '';
	const out = typeof args?.out === 'string' ? args.out.trim() : '';
	if (out && /\.glb$/i.test(out)) return out;
	if (MODULE_FILE.test(path)) return defaultGlbPath(path);
	if (MODEL_FILE.test(path)) return path;
	return null;
}
