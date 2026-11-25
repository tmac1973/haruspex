/**
 * Whether a 3D delegate call is done, decided in code: the same build and
 * check as `check_3d`, run on the files on disk, so the delegate's own steps
 * can't get round it. The caller's host writes only the GLB.
 */
import { runCheck3d, type Check3dHost } from '#lib/helpers/three/call.ts';
import type { Delegate3dFiles } from '#lib/helpers/three/delegatePrompt.ts';
import { readFile } from '#lib/helpers/three/load.ts';

export interface FinalCheck3d {
	/** The report has no error lines. */
	ok: boolean;
	/** The check's report, or why there was none. */
	text: string;
	/** The error lines; empty when `ok`. */
	problems: string[];
	/** The render sheet, when one was drawn. */
	png?: string;
}

export const MODULE_NEVER_WRITTEN = 'The module was never written.';

/**
 * The `check_3d` options that change what the GLB is or how its clips are
 * judged. The final check keeps the delegate's own, so it neither undoes a
 * scaled, grounded GLB nor fails a clip the delegate marked airborne. `clip`
 * and `view` only pick what the sheet shows, and are left out.
 */
const KEPT_OPTIONS = ['height', 'ground', 'clips', 'max_triangles', 'spec_height'];

const samePath = (a: unknown, b: string) =>
	typeof a === 'string' &&
	a
		.trim()
		.replace(/\\/g, '/')
		.replace(/^(\.\/)+/, '') === b.replace(/\\/g, '/');

/** The kept options of the delegate's last `check_3d` call on `module`; {} when it made none. */
export function lastCheckOptions(
	steps: { toolName: string; args?: Record<string, unknown> }[],
	module: string
): Record<string, unknown> {
	const last = steps.findLast((s) => s.toolName === 'check_3d' && samePath(s.args?.path, module));
	const args = last?.args ?? {};
	return Object.fromEntries(
		KEPT_OPTIONS.filter((k) => args[k] !== undefined).map((k) => [k, args[k]])
	);
}

/**
 * Build and check `paths` as `check_3d` would, with the delegate's own
 * `options` (`lastCheckOptions`), writing the GLB through `host`.
 */
export async function finalCheck3d(
	paths: Delegate3dFiles,
	host: Check3dHost,
	options: Record<string, unknown> = {}
): Promise<FinalCheck3d> {
	const exists = async (path: string) =>
		'bytes' in (await readFile(path, { read: host.read, cwd: host.cwd, runFrame: host.runFrame }));
	if (!(await exists(paths.module))) {
		return { ok: false, text: MODULE_NEVER_WRITTEN, problems: [`- ${MODULE_NEVER_WRITTEN}`] };
	}
	const anim = (await exists(paths.anim)) ? paths.anim : undefined;
	const reply = await runCheck3d(
		{ ...options, path: paths.module, ...(anim ? { anim } : {}), out: paths.glb },
		host
	);
	if ('error' in reply) return { ok: false, text: reply.error, problems: [`- ${reply.error}`] };
	return {
		ok: reply.ok,
		text: reply.text,
		problems: reply.problems,
		...(reply.png ? { png: reply.png } : {})
	};
}
