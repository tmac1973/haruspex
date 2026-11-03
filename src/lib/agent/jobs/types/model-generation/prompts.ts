/** Prompts for the 3D models job. */

import { SUBMIT_MODEL_SPEC_TOOL } from '#lib/agent/jobs/types/model-generation/tools.ts';
import { DRAW_TEXTURE_TOOL } from '#lib/agent/tools/draw-texture.ts';
import { modelFiles } from '#lib/models3d/spec/paths.ts';
import { MAX_ENTRIES, type ModelEntry, type ModelSpec } from '#lib/models3d/spec/types.ts';

/** The spec stage's system prompt: list the models from the user's description. */
export function modelSpecPrompt(description: string, specPath: string): string {
	return [
		'You are listing the 3D models a project needs, so they can be built in code.',
		'',
		`What the user asked for: ${description}`,
		'',
		'Process:',
		'1. Look at the working directory first. If there is content on disk (a plan,',
		'   data files, source that loads models), read it and let it decide the list.',
		'2. Decide one shared style line: polygon level, shading and palette feel,',
		'   e.g. "low-poly, flat colours, chunky proportions". No subject.',
		`3. List one entry per distinct model, at most ${MAX_ENTRIES}. Each entry:`,
		'   - title: what it is, two or three words.',
		'   - description: its shape, main parts and colours, in one or two sentences.',
		'   - height_m: its overall height in metres, so the set shares one scale',
		'     (a door is about 2, a person 1.8, a crate 0.6).',
		'   - parts and clips only for a model that moves. parts are the pivot names',
		'     at its joints, written Side_Part: Hip_L, Knee_L, Hip_R, Knee_R,',
		'     Shoulder_L, Elbow_L, Neck. Every pivot a clip moves must be listed.',
		'   - clips: name, seconds (0.2 to 10), loop, and action (what happens).',
		'   - A static prop (crate, tree, rock) has no parts and no clips.',
		'',
		`The runner writes the result to ${specPath}, gives each entry its id and`,
		`folder, and checks it. Call \`${SUBMIT_MODEL_SPEC_TOOL}\` once, at the end.`
	].join('\n');
}

/** The retry message: the problems the last submission had. */
export function modelSpecRetryPrompt(problems: string[]): string {
	return [
		'That spec has problems:',
		'',
		...problems.map((p) => `- ${p}`),
		'',
		`Call \`${SUBMIT_MODEL_SPEC_TOOL}\` again with the whole list corrected. Do not explain;`,
		'submit.'
	].join('\n');
}

/** The rig rule, word for word in every creation prompt: animation depends on it. */
export const RIG_RULE =
	'Every name in Parts is an Object3D pivot placed at the joint it turns about, holding the ' +
	'meshes it moves, nested parent → child (Hip_L > Knee_L). Animation rotates these pivots ' +
	'and nothing else.';

/**
 * The creation stage's system prompt, the same for every entry and every
 * round: what a build module is, the units, the rig rule and the check loop.
 * The entry itself goes in the user message.
 */
export function createSystemPrompt(spec: ModelSpec, allowTextures: boolean): string {
	return [
		'You build one 3D model in code: a Three.js build module, checked with `check_3d`.',
		'',
		'The build module:',
		'- `export default function build(THREE, kit)` returns one Object3D. No imports.',
		'- kit: mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry,',
		'  ParametricGeometry, createNoise(seed), random(seed)' +
			(allowTextures ? ', texture(path).' : '.'),
		'- Units are metres, y is up, the front faces +z, the feet stand on y = 0.',
		'- Name every mesh.',
		'- No clips: build returns the object only. Another stage animates it.',
		...(spec.style ? ['', `Style for every model in this set: ${spec.style}`] : []),
		'',
		`Rig: ${RIG_RULE}`,
		allowTextures
			? [
					'',
					'Colour with materials and vertex colours, kit.createNoise for variation. For a',
					`surface that needs a pattern, call \`${DRAW_TEXTURE_TOOL}\` with path`,
					"`<folder>textures/<name>.png`, <folder> being the model's folder, then use",
					"`kit.texture('textures/<name>.png')` in the module (a string literal)."
				].join('\n')
			: '\nColour with materials and vertex colours, kit.createNoise for variation. No textures.',
		'',
		'Process:',
		'1. Write the module with `fs_write_text`.',
		'2. Call `check_3d` with `path` = the .js and `out` = the .glb.',
		'3. Fix everything it reports and check again. Look at the render sheet: the',
		'   shape, proportions and colours must match the description.',
		'4. Stop when the check is clean and the model looks right. Write files only in',
		"   the model's folder."
	].join('\n');
}

/** The first message for one entry: what to build and where. */
export function createEntryPrompt(entry: ModelEntry, note: string | null = null): string {
	const f = modelFiles(entry);
	return [
		...(note ? [`The user reviewed this model and asked for a change: ${note}`, ''] : []),
		`Build: ${entry.title}`,
		'',
		entry.description,
		'',
		`Folder: ${entry.dir}`,
		`Height: ${entry.height_m} m.`,
		entry.parts.length > 0
			? `Parts (pivots, named exactly so): ${entry.parts.join(', ')}.`
			: 'Parts: none; a static model.',
		'',
		`Write ${f.build}, then check it with check_3d (path ${f.build}, out ${f.glb}).`,
		...(note ? ['', `${f.build} may already exist: read it, then change what the note asks.`] : [])
	].join('\n');
}

/** The next round's message: what the last check found, for a fresh turn. */
export function createRepairPrompt(entry: ModelEntry, problems: string[]): string {
	const f = modelFiles(entry);
	return [
		`${entry.title} (${f.build}) is not done yet. The last check found:`,
		'',
		...problems.map((p) => `- ${p}`),
		'',
		`Height: ${entry.height_m} m.` +
			(entry.parts.length > 0 ? ` Parts: ${entry.parts.join(', ')}.` : ''),
		'',
		`Read ${f.build}. Fix ${entry.id}.js and check it again (path ${f.build}, out ${f.glb}).`
	].join('\n');
}
