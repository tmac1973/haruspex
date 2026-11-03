/**
 * `check_3d`: the 3D helper's tool (Settings → Code → Helpers). The agent
 * writes a Three.js build module and this builds it in the sandbox, exports
 * the GLB and returns a report and a six-view render sheet; or it checks a
 * .glb/.gltf made another way (Blender) and returns the same. No model.
 */
import { assetIo, writeAsset } from '#lib/agent/tools/_assetIo.ts';
import { ctxCwd, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { READ_ONLY_REFUSAL } from '#lib/agent/tools/codeTabProfile.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { checkGlb, type CheckOptions } from '#lib/glb/check.ts';
import {
	check3dFile,
	defaultGlbPath,
	MODEL_FILE as MODEL,
	MODULE_FILE as MODULE
} from '#lib/helpers/three/output.ts';
import { runBuildModule } from '#lib/helpers/three/runModule.ts';
import { errMessage } from '#lib/utils/error.ts';

export const SHEET_NOTE =
	'The render sheet is attached (front, right, back, left, top, three-quarter, over a floor grid): compare it with what you meant to make before you finish.';
export const MOTION_NOTE =
	"The motion sheet is attached (right and front frames, then all frames overlaid with trails of the parts that move most). 'No problems found' only means nothing is physically wrong: check the key pose reads at a glance from the side and the front, fix what you see, and call check_3d again before you finish.";

const DESCRIPTION = `Build a 3D model from a Three.js module you write, or check a .glb made another way (Blender). Returns size, parts and problems, and a render sheet (front, right, back, left, top, three-quarter, over a floor grid). A module imports nothing; its default export gets THREE (the app's three) and kit (mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry, ParametricGeometry, createNoise(seed), random(seed)) and returns an Object3D, or { object, animations } for clips:
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
Animate with tracks on named nodes, e.g. new THREE.QuaternionKeyframeTrack('Shin_L.quaternion', [0, 0.5], [...]); every call checks each clip, and clip: "Walk" shows it moving. Look at poses this way, not with scripts of your own.
Name every mesh. Units are metres, y is up, the front faces +z.`;

interface Args {
	path: string;
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

/** The arguments, checked, or why they can't be used. */
function parseArgs(args: Record<string, unknown>): Args | string {
	const path = typeof args.path === 'string' ? args.path.trim() : '';
	if (!MODULE.test(path) && !MODEL.test(path)) {
		return 'path must be a .js or .mjs build module, or a .glb or .gltf file.';
	}
	const { height, ground, max_triangles: max, clip } = args;
	const bad = numberProblem(height, max);
	if (bad) return bad;
	if (clip !== undefined && !(typeof clip === 'string' && clip.trim())) {
		return 'clip must be the name of an animation clip.';
	}
	const out = outPath(args.out, path, height !== undefined || ground === true);
	if (typeof out === 'string') return out;
	return {
		path,
		out: out.out,
		opts: {
			height: height as number | undefined,
			ground: ground === true,
			maxTriangles: max as number | undefined,
			clip: typeof clip === 'string' ? clip.trim() : undefined
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

function failed(lines: string[], path: string): string {
	return ['The check failed.', ...lines, `Fix ${path} and call check_3d again.`].join('\n');
}

interface Source {
	glb: Uint8Array;
	/** A module's tracks that name a node it doesn't have. */
	missing: string[];
}

/** The GLB bytes to check: a module's export, or the file itself. */
async function source(a: Args, abs: string, ctx: ToolContext): Promise<Source | string> {
	let bytes: number[];
	try {
		bytes = await assetIo(ctx).read(abs);
	} catch (e) {
		return toolError(`Could not read ${a.path}: ${errMessage(e)}`);
	}
	if (MODEL.test(a.path)) {
		if (/\.gltf$/i.test(a.path) && externalGltf(bytes)) {
			return toolError('Export it as .glb, or embed its buffers and images in the .gltf.');
		}
		return { glb: new Uint8Array(bytes), missing: [] };
	}
	ctx.onProgress?.('Building');
	const run = await runBuildModule(new TextDecoder().decode(new Uint8Array(bytes)), {
		signal: ctx.signal
	});
	if (run.errors.length || !run.glb) {
		const lines = run.errors.map((e) =>
			e.line === null ? `- ${e.message}` : `- line ${e.line}: ${e.message}`
		);
		return failed(lines.length ? lines : ['- build() exported nothing.'], a.path);
	}
	return { glb: run.glb, missing: run.missingTracks };
}

async function executeCheck3d(args: Record<string, unknown>, ctx: ToolContext) {
	if (ctx.codeReadOnly) return toolResult(toolError(READ_ONLY_REFUSAL));
	const a = parseArgs(args);
	if (typeof a === 'string') return toolResult(toolError(a));
	const cwd = ctxCwd(ctx);
	const got = await source(a, resolveShellPath(a.path, cwd), ctx);
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
		checked.text,
		...(sees ? [checked.clip ? MOTION_NOTE : SHEET_NOTE] : [])
	];
	return toolResult(lines.join('\n'), checked.png ?? undefined);
}

/** The line about tracks the exporter dropped, if there were any. */
function missingLine(missing: string[]): string[] {
	if (!missing.length) return [];
	const names = missing.slice(0, 12).join(', ');
	return [
		`Tracks naming a node the model doesn't have (the exporter dropped them, so they do nothing): ${names}.`
	];
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
