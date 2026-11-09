/**
 * `check_3d`: the 3D helper's tool (Settings → Code → Helpers). The agent
 * writes a Three.js build module and this builds it in the sandbox, exports
 * the GLB and returns a report and a six-view render sheet; or it checks a
 * .glb/.gltf made another way (Blender) and returns the same. No model.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { READ_ONLY_REFUSAL } from '#lib/agent/tools/_codeTabProfile.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { checkGlb, type CheckOptions } from '#lib/glb/check.ts';
import type { ClipFlags } from '#lib/glb/motion.ts';
import type { GlbReport } from '#lib/glb/report.ts';
import {
	check3dFile,
	defaultGlbPath,
	MODEL_FILE as MODEL,
	MODULE_FILE as MODULE
} from '#lib/helpers/three/output.ts';
import type { ClampedColours } from '#lib/helpers/three/runModule.ts';
import {
	clampedLine,
	failed,
	loadModuleRun,
	missingLine,
	closeUpNote,
	MOTION_NOTE,
	readFile,
	runFailure,
	SHEET_NOTE,
	type LoadIo
} from '#lib/helpers/three/load.ts';

export { MOTION_NOTE, SHEET_NOTE };

const DESCRIPTION = `Build a 3D model from a Three.js module you write, or check a .glb made another way (Blender). Returns size, parts and problems, and a render sheet (front, right, back, left, top, three-quarter, over a floor grid). A module imports nothing; its default export gets THREE (the app's three) and kit (mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry, ParametricGeometry, createNoise(seed) → {noise2, noise3}, random(seed)) and returns an Object3D, or { object, animations } for clips:
\`\`\`js
export default function build(THREE, kit) {
  const asset = new THREE.Group();
  const glass = new THREE.MeshStandardMaterial({ color: 0x4aa8e0, transparent: true, opacity: 0.5 });
  const pts = [[0, 0], [0.12, 0.02], [0.15, 0.1], [0.05, 0.22], [0.04, 0.3]].map(([x, y]) => new THREE.Vector2(x, y));
  const flask = new THREE.Mesh(new THREE.LatheGeometry(pts, 10), glass);
  flask.name = 'Flask';
  asset.add(flask);
  return asset;
}
\`\`\`
Animate with tracks on named nodes, e.g. new THREE.QuaternionKeyframeTrack('Shin_L.quaternion', [0, 0.5], [...]); every call checks each clip, and clip: "Walk" shows it moving. A walk or run plays in place: the body stays over the origin and planted feet move back (-z) at one steady speed. A loop ends on its first pose at the same speed; a one-shot starts and ends at rest. Names decide which clips loop (Idle, Walk, Run, Fly, Hover, Swim) and which may leave the floor (runs, jumps, flight); pass clips to say otherwise. Clips may live in their own module, passed as anim: its default export animate(THREE, object, kit) gets the built object and returns an array of AnimationClip. kit.texture('textures/bark.png') gives a Texture from a PNG next to the module; pass the path as a string literal. To change an existing clip, call check_3d with clip on it first, before editing, and after each change; look at poses this way, not with scripts of your own.
Name every mesh. Units are metres, y is up, the front faces +z.`;

interface Args {
	path: string;
	/** An animation module run beside the build module `path`. */
	anim?: string;
	out?: string;
	opts: CheckOptions;
}

/** Why `height` or `max_triangles` can't be used, or null. */
function numberProblem(height: unknown, max: unknown): string | null {
	if (
		height !== undefined &&
		!(typeof height === 'number' && Number.isFinite(height) && height > 0)
	) {
		return 'height must be a number of metres above 0.';
	}
	if (max !== undefined && !(typeof max === 'number' && Number.isInteger(max) && max > 0)) {
		return 'max_triangles must be a whole number above 0.';
	}
	return null;
}

/** Where the GLB goes (undefined: nowhere), or why `out` can't be used. */
function outPath(
	raw: unknown,
	path: string,
	normalise: boolean
): { out: string | undefined } | string {
	const out = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
	if (out !== undefined && !/\.glb$/i.test(out)) return 'out must end in .glb.';
	if (out !== undefined && out === path) return 'out must not be the file you are checking.';
	if (MODULE.test(path)) return { out: out ?? defaultGlbPath(path) };
	if (normalise && out === undefined) {
		return 'Pass out: normalising a .glb writes a copy there and leaves the original alone.';
	}
	return { out };
}

/** The animation module's path (undefined: none), or why it can't be used. */
function animPath(raw: unknown, path: string): string | undefined | { problem: string } {
	const anim = typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
	if (anim === undefined) return undefined;
	if (!MODULE.test(path)) {
		return { problem: 'anim works only with a .js or .mjs build module as path.' };
	}
	if (!MODULE.test(anim)) return { problem: 'anim must be a .js or .mjs module.' };
	if (anim === path) return { problem: 'anim must be a different file from path.' };
	return anim;
}

/** Why `clip`, `view` or `spec_height` can't be used, or null. */
function showProblem(clip: unknown, view: unknown, spec: unknown): string | null {
	if (spec !== undefined && !(typeof spec === 'number' && Number.isFinite(spec) && spec > 0)) {
		return 'spec_height must be a number of metres above 0.';
	}
	if (clip !== undefined && !(typeof clip === 'string' && clip.trim())) {
		return 'clip must be the name of an animation clip.';
	}
	if (view !== undefined && !(typeof view === 'string' && view.trim())) {
		return 'view must be a part\'s name, or "head".';
	}
	if (view !== undefined && clip !== undefined) return 'Pass view or clip, not both.';
	return null;
}

/** Each clip's `loop` and `airborne` flags, or why `clips` can't be used. */
function clipFlagsArg(raw: unknown): Record<string, ClipFlags> | undefined | string {
	if (raw === undefined) return undefined;
	const bad =
		'clips must map clip names to { loop, airborne }, e.g. { "Hover": { "loop": true, "airborne": true } }.';
	const isObject = (v: unknown): v is Record<string, unknown> =>
		!!v && typeof v === 'object' && !Array.isArray(v);
	const isFlag = (v: unknown) => v === undefined || typeof v === 'boolean';
	if (!isObject(raw)) return bad;
	const out: Record<string, ClipFlags> = {};
	for (const [name, v] of Object.entries(raw)) {
		if (!isObject(v)) return bad;
		const { loop, airborne, ...rest } = v;
		if (Object.keys(rest).length || !isFlag(loop) || !isFlag(airborne)) return bad;
		out[name] = { loop: loop as boolean | undefined, airborne: airborne as boolean | undefined };
	}
	return out;
}

/** The arguments, checked, or why they can't be used. */
function parseArgs(args: Record<string, unknown>): Args | string {
	const path = typeof args.path === 'string' ? args.path.trim() : '';
	if (!MODULE.test(path) && !MODEL.test(path)) {
		return 'path must be a .js or .mjs build module, or a .glb or .gltf file.';
	}
	const anim = animPath(args.anim, path);
	if (typeof anim === 'object') return anim.problem;
	const { height, ground, max_triangles: max, clip, view, spec_height: spec } = args;
	const bad = numberProblem(height, max) ?? showProblem(clip, view, spec);
	if (bad) return bad;
	const flags = clipFlagsArg(args.clips);
	if (typeof flags === 'string') return flags;
	const out = outPath(args.out, path, height !== undefined || ground === true);
	if (typeof out === 'string') return out;
	return {
		path,
		anim,
		out: out.out,
		opts: {
			height: height as number | undefined,
			ground: ground === true,
			maxTriangles: max as number | undefined,
			clip: typeof clip === 'string' ? clip.trim() : undefined,
			view: typeof view === 'string' ? view.trim() : undefined,
			specHeight: spec as number | undefined,
			clips: flags
		}
	};
}

/** A .gltf that points at files beside it, which this can't follow. */
function externalGltf(bytes: number[]): boolean {
	try {
		const json = JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as {
			buffers?: { uri?: string }[];
			images?: { uri?: string }[];
		};
		return [...(json.buffers ?? []), ...(json.images ?? [])].some(
			(x) => typeof x.uri === 'string' && !x.uri.startsWith('data:')
		);
	} catch {
		return false;
	}
}

interface Source {
	glb: Uint8Array;
	/** A module's tracks that name a node it doesn't have. */
	missing: string[];
	clamped: ClampedColours | null;
	/** An animation module beside the build module that wasn't passed as `anim`. */
	animBeside: string | null;
}

/** The GLB bytes to check: a module's export, or the file itself. */
async function source(a: Args, cwd: string | null, ctx: ToolContext): Promise<Source | string> {
	const io: LoadIo = { read: (p) => assetIo(ctx).read(p), cwd };
	if (MODEL.test(a.path)) {
		const got = await readFile(a.path, io);
		if ('refused' in got) return toolError(got.refused);
		if (/\.gltf$/i.test(a.path) && externalGltf(got.bytes)) {
			return toolError('Export it as .glb, or embed its buffers and images in the .gltf.');
		}
		return { glb: new Uint8Array(got.bytes), missing: [], clamped: null, animBeside: null };
	}
	ctx.onProgress?.('Building');
	const run = await loadModuleRun({ build: a.path, anim: a.anim }, io, ctx.signal);
	if ('refused' in run) return toolError(run.refused);
	if (run.errors.length || !run.glb) return runFailure(run.errors, { build: a.path, anim: a.anim });
	const animBeside = a.anim === undefined ? await animModuleBeside(a.path, io) : null;
	return { glb: run.glb, missing: run.missing, clamped: run.clamped, animBeside };
}

/**
 * `knight.anim.js` (or `knight_anim.js`, `knight-anim.js`) beside `knight.js`,
 * when it exists. A model that checks its build module alone gets "No
 * animation." and may not see why: in the 2026-11-04 tests one called check_3d
 * 21 times without `anim`, sure it had passed it.
 */
async function animModuleBeside(build: string, io: LoadIo): Promise<string | null> {
	for (const sep of ['.', '_', '-']) {
		const beside = build.replace(/\.(m?js)$/i, `${sep}anim.$1`);
		if (beside === build) return null;
		if ('bytes' in (await readFile(beside, io))) return beside;
	}
	return null;
}

async function executeCheck3d(args: Record<string, unknown>, ctx: ToolContext) {
	if (ctx.codeReadOnly) return toolResult(toolError(READ_ONLY_REFUSAL));
	const a = parseArgs(args);
	if (typeof a === 'string') return toolResult(toolError(a));
	const cwd = ctxCwd(ctx);
	const got = await source(a, cwd, ctx);
	if (typeof got === 'string') return toolResult(got);

	ctx.onProgress?.('Checking');
	const checked = await checkGlb(got.glb, a.opts);
	if ('problems' in checked)
		return toolResult(
			failed(
				checked.problems.map((p) => `- ${p}`),
				a.path
			)
		);

	const target = MODULE.test(a.path) || checked.normalisedFrom ? a.out : undefined;
	if (target) {
		const refused = await writeAsset(
			resolveShellPath(target, cwd),
			checked.bytes,
			true,
			false,
			assetIo(ctx)
		);
		if (refused) return toolResult(toolError(refused));
	}
	const sees = attachSheet(ctx, target ?? a.path, checked.png);
	const lines = [
		target ? `Wrote ${target}.` : `Checked ${a.path} (nothing written).`,
		...missingLine(got.missing),
		...clampedLine(got.clamped),
		checked.text,
		...unknownClipsLine(a.opts.clips, checked.report),
		...animBesideLine(got.animBeside, checked.report),
		...(sees ? [sheetNote(checked)] : [])
	];
	return toolResult(lines.join('\n'), checked.png ?? undefined);
}

/** The line naming `clips` entries the GLB has no clip for, so a typo isn't silently ignored. */
function unknownClipsLine(
	flags: Record<string, ClipFlags> | undefined,
	report: GlbReport
): string[] {
	if (!flags) return [];
	const has = new Set(report.animations.map((a) => a.name));
	const unknown = Object.keys(flags).filter((n) => !has.has(n));
	return unknown.length
		? [`clips names ${unknown.join(', ')}, which the GLB has no clip for.`]
		: [];
}

/** The line pointing at an unpassed animation module, when the GLB came out with no clips. */
function animBesideLine(beside: string | null, report: GlbReport): string[] {
	if (!beside || report.animations.length > 0) return [];
	return [`${beside} was not passed: add anim: "${beside}" to check its clips.`];
}

/** What the attached sheet is: the motion sheet, a close-up, or the render sheet. */
function sheetNote(checked: { clip?: string; closeUp?: string }): string {
	if (checked.clip) return MOTION_NOTE;
	return checked.closeUp ? closeUpNote(checked.closeUp) : SHEET_NOTE;
}

/** Give the agent the sheet when its model can see it; whether it did. */
function attachSheet(ctx: ToolContext, path: string, png: string | null): boolean {
	if (png === null || ctx.visionSupported === false) return false;
	if (ctx.pendingImages.length >= MAX_PENDING_IMAGES) return false;
	ctx.pendingImages.push({ path, dataUrl: png });
	return true;
}

registerTool({
	category: 'fs',
	schema: {
		type: 'function',
		function: {
			name: 'check_3d',
			description: DESCRIPTION,
			parameters: {
				type: 'object',
				properties: {
					path: {
						type: 'string',
						description:
							'A .js/.mjs build module, or a .glb/.gltf file, relative to the session folder.'
					},
					anim: {
						type: 'string',
						description:
							'An animation module (.js): its default export animate(THREE, object, kit) returns an array of AnimationClip for the object path builds. Only with a module path.'
					},
					out: {
						type: 'string',
						description:
							'Where to write the GLB. A module defaults to its own name with .glb; a .glb needs out to be normalised.'
					},
					height: {
						type: 'number',
						description: 'Scale the model uniformly to this many metres tall.'
					},
					ground: {
						type: 'boolean',
						description: 'Put the feet on y = 0, centred on x and z.'
					},
					max_triangles: {
						type: 'number',
						description: 'Warn when the model has more triangles than this.'
					},
					clip: {
						type: 'string',
						description:
							"An animation clip's name: show that clip moving instead of the still sheet."
					},
					view: {
						type: 'string',
						description:
							'A part to see close up instead of the whole: a mesh or pivot name, or "head". The same six views, framed on it.'
					},
					clips: {
						type: 'object',
						description:
							'Per clip, what it is when its name says otherwise: { "Hover": { "loop": true, "airborne": true } }. loop: it cycles, so it must end on its first pose. airborne: it leaves the floor on purpose. A flag you leave out goes by the name. The clip line says what you set.',
						additionalProperties: {
							type: 'object',
							properties: { loop: { type: 'boolean' }, airborne: { type: 'boolean' } }
						}
					},
					spec_height: {
						type: 'number',
						description:
							'The height the model should be, in metres: warns when it is off by over 10%.'
					}
				},
				required: ['path']
			}
		}
	},
	execute: executeCheck3d,
	// The model file: the step card links it (`SearchStep.svelte`).
	displayLabel: (args) => check3dFile(args) ?? String(args.path ?? '')
});
