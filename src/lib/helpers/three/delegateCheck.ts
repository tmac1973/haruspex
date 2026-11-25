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

/** Build and check `paths` as `check_3d` would, writing the GLB through `host`. */
export async function finalCheck3d(
	paths: Delegate3dFiles,
	host: Check3dHost
): Promise<FinalCheck3d> {
	const exists = async (path: string) =>
		'bytes' in (await readFile(path, { read: host.read, cwd: host.cwd, runFrame: host.runFrame }));
	if (!(await exists(paths.module))) {
		return { ok: false, text: MODULE_NEVER_WRITTEN, problems: [`- ${MODULE_NEVER_WRITTEN}`] };
	}
	const anim = (await exists(paths.anim)) ? paths.anim : undefined;
	const reply = await runCheck3d(
		{ path: paths.module, ...(anim ? { anim } : {}), out: paths.glb },
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
