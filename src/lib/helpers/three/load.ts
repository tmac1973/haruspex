/**
 * Running a build module from files: read it and its animation module, read
 * the PNGs they name with `kit.texture`, and build the GLB. `check_3d` and
 * the models job's verdict (`glb/verdict.ts`) both come through here, so a
 * model is judged the same way whichever asks. Also the report lines both
 * write about a run, so their text matches.
 */
import { resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { runBuildModule, type ModuleError } from '#lib/helpers/three/runModule.ts';
import {
	MAX_TEXTURE_BYTES,
	MAX_TEXTURES,
	textureRefs,
	texturePath
} from '#lib/helpers/three/textures.ts';
import { bytesToBase64 } from '#lib/utils/base64.ts';
import { errMessage } from '#lib/utils/error.ts';

export const SHEET_NOTE =
	'The render sheet is attached (front, right, back, left, top, three-quarter, over a floor grid): compare it with what you meant to make before you finish.';
export const MOTION_NOTE =
	"The motion sheet is attached (right and front frames, then all frames overlaid with trails of the parts that move most). 'No problems found' only means nothing is physically wrong: check the key pose reads at a glance from the side and the front, fix what you see, and call check_3d again before you finish.";

/** The modules to run, relative to `cwd`. */
export interface ModulePaths {
	build: string;
	/** An animation module run beside the build module. */
	anim?: string;
}

export interface LoadIo {
	/** A file's bytes, by its resolved path; throws when it can't. */
	read(path: string): Promise<number[]>;
	cwd: string | null;
}

/** A module run, or why it couldn't start (a file it couldn't read, a bad texture). */
export type ModuleLoad =
	| {
			glb: Uint8Array | null;
			/** Tracks naming a node the model doesn't have. */
			missing: string[];
			errors: ModuleError[];
	  }
	| { refused: string };

/** A file's bytes, or the message saying it couldn't be read. */
export async function readFile(
	path: string,
	io: LoadIo
): Promise<{ bytes: number[] } | { refused: string }> {
	try {
		return { bytes: await io.read(resolveShellPath(path, io.cwd)) };
	} catch (e) {
		return { refused: `Could not read ${path}: ${errMessage(e)}` };
	}
}

export const text = (bytes: number[]) => new TextDecoder().decode(new Uint8Array(bytes));

/** The folder part of `path`: '' for a file in the working folder. */
function dirOf(path: string): string {
	const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
	return i < 0 ? '' : i === 0 ? '/' : path.slice(0, i);
}

/**
 * The PNGs the module sources name with `kit.texture`, read from beside the
 * build module `path` as data URLs keyed by the path as written; or the
 * message that stops the run.
 */
async function readTextures(
	sources: string[],
	path: string,
	io: LoadIo
): Promise<{ textures: Record<string, string> } | { refused: string }> {
	const refs = [...new Set(sources.flatMap(textureRefs))];
	if (refs.length > MAX_TEXTURES) {
		return { refused: `kit.texture names ${refs.length} PNGs; use at most ${MAX_TEXTURES}.` };
	}
	const root = io.cwd?.replace(/[/\\]+$/, '');
	const out: Record<string, string> = {};
	for (const ref of refs) {
		if (!/\.png$/i.test(ref)) return { refused: `kit.texture("${ref}"): only .png files.` };
		const rel = texturePath(dirOf(path), ref);
		const full = rel === null ? null : resolveShellPath(rel, io.cwd);
		if (full === null || (root && !full.startsWith(`${root}/`))) {
			return {
				refused: `kit.texture("${ref}"): the PNG must be inside the working folder.`
			};
		}
		const got = await readFile(rel as string, io);
		if ('refused' in got) return got;
		if (got.bytes.length > MAX_TEXTURE_BYTES) {
			const mb = MAX_TEXTURE_BYTES / 1024 / 1024;
			return { refused: `kit.texture("${ref}"): the PNG is over ${mb} MB.` };
		}
		out[ref] = `data:image/png;base64,${bytesToBase64(new Uint8Array(got.bytes))}`;
	}
	return { textures: out };
}

/** Read a build module, its animation module and their textures, and run them. */
export async function loadModuleRun(
	paths: ModulePaths,
	io: LoadIo,
	signal?: AbortSignal
): Promise<ModuleLoad> {
	const build = await readFile(paths.build, io);
	if ('refused' in build) return build;
	let anim: string | undefined;
	if (paths.anim !== undefined) {
		const got = await readFile(paths.anim, io);
		if ('refused' in got) return got;
		anim = text(got.bytes);
	}
	const source = text(build.bytes);
	const tex = await readTextures([source, anim ?? ''], paths.build, io);
	if ('refused' in tex) return tex;
	const run = await runBuildModule(source, { signal, anim, textures: tex.textures });
	return { glb: run.glb, missing: run.missingTracks, errors: run.errors };
}

/** The failure lines for a module run's errors; those from the animation module name it. */
export function errorLines(errors: ModuleError[], anim: string | undefined): string[] {
	return errors.map((e) => {
		if (e.file === 'anim' && anim) {
			return e.line === null ? `- ${anim}: ${e.message}` : `- ${anim}:${e.line}: ${e.message}`;
		}
		return e.line === null ? `- ${e.message}` : `- line ${e.line}: ${e.message}`;
	});
}

export function failed(lines: string[], path: string): string {
	return ['The check failed.', ...lines, `Fix ${path} and call check_3d again.`].join('\n');
}

/** What a run that built nothing says: its error lines, and the file to fix. */
export function runFailure(errors: ModuleError[], paths: ModulePaths): string {
	const lines = errorLines(errors, paths.anim);
	const fromAnim = errors.length > 0 && errors.every((e) => e.file === 'anim');
	const fix = paths.anim !== undefined && fromAnim ? paths.anim : paths.build;
	return failed(lines.length ? lines : ['- build() exported nothing.'], fix);
}

/** The line about tracks the exporter dropped, if there were any. */
export function missingLine(missing: string[]): string[] {
	if (!missing.length) return [];
	const names = missing.slice(0, 12).join(', ');
	return [
		`Tracks naming a node the model doesn't have (the exporter dropped them, so they do nothing): ${names}.`
	];
}
