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

/** What the creation model may colour with: the job's Allow textures and Noise colour. */
export interface ColourOptions {
	textures: boolean;
	noiseColour: boolean;
}

/** How to colour a model, in the creation prompt. */
function colourRule({ textures, noiseColour }: ColourOptions): string {
	const base = noiseColour
		? 'Colour with materials and vertex colours, kit.createNoise for variation.'
		: 'Colour each part with a plain material colour: no noise or speckle in colours.';
	if (!textures) return `${base} No textures.`;
	return [
		base,
		`For a surface that needs a pattern, call \`${DRAW_TEXTURE_TOOL}\` with path`,
		"`<folder>textures/<name>.png`, <folder> being the model's folder, then use",
		"`kit.texture('textures/<name>.png')` in the module (a string literal)."
	].join('\n');
}

/**
 * The creation stage's system prompt, the same for every entry and every
 * round: what a build module is, the units, the rig rule and the check loop.
 * The entry itself goes in the user message.
 */
export function createSystemPrompt(spec: ModelSpec, colour: ColourOptions): string {
	return [
		'You build one 3D model in code: a Three.js build module, checked with `check_3d`.',
		'',
		'The build module:',
		'- `export default function build(THREE, kit)` returns one Object3D. No imports.',
		'- kit: mergeGeometries, mergeVertices, RoundedBoxGeometry, ConvexGeometry,',
		'  ParametricGeometry, random(seed) (a function giving [0, 1)), createNoise(seed)',
		'  (an object: noise2(x, y) and noise3(x, y, z), each in [-1, 1])' +
			(colour.textures ? ', texture(path).' : '.'),
		'- Units are metres, y is up, the front faces +z, the feet stand on y = 0.',
		'- Name every mesh.',
		'- No clips: build returns the object only. Another stage animates it.',
		...(spec.style ? ['', `Style for every model in this set: ${spec.style}`] : []),
		'',
		`Rig: ${RIG_RULE}`,
		'',
		colourRule(colour),
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
		`Write ${f.build}, then check it with check_3d (path ${f.build}, out ${f.glb}, spec_height ${entry.height_m}).`,
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

/**
 * The animation stage's system prompt: what an animation module is, which
 * nodes it may move, and that the build module is not its to change.
 */
export function animateSystemPrompt(): string {
	return [
		'You animate one 3D model that is already built, with a Three.js animation module',
		'checked by `check_3d`.',
		'',
		'The animation module:',
		'- `export default function animate(THREE, object, kit)` returns an array of',
		'  THREE.AnimationClip. No imports. `object` is what the build module returned.',
		"- Find each pivot with `object.getObjectByName('Hip_L')`. Animate only the named",
		'  pivots: QuaternionKeyframeTrack on `<name>.quaternion`, VectorKeyframeTrack on',
		'  `<name>.position`. Start from each pivot’s rest pose (its current quaternion and',
		'  position) and move away from it.',
		'- One clip per name in the list, with that name and length in seconds.',
		'- A looping clip ends on exactly its first pose, moving as it does at the start.',
		'  A one-shot starts and ends at the rest pose, so the game can blend into it.',
		'- A walk or run plays in place, since the game moves the model: the body stays over',
		'  the origin, and each planted foot moves back (−z) at one steady speed, then lifts.',
		'- Units are metres, y is up, the front faces +z.',
		'',
		'The build module is not yours: do not edit it. A changed build module is put back.',
		'',
		'Process:',
		'1. Write the animation module with `fs_write_text`.',
		'2. For each clip, call `check_3d` with `path` = the build module, `anim` = the',
		'   animation module, `out` = the .glb and `clip` = the clip name.',
		'3. Fix what it reports and look at the motion sheet: the poses must do what the',
		'   clip says. Check again after each change.',
		'4. Stop when every clip checks clean: the turn ends on its own once they pass.',
		'   Write files only in the model’s folder.'
	].join('\n');
}

/** The first animation message: the clips, and the build module so the hierarchy is in view. */
export function animateEntryPrompt(entry: ModelEntry, buildSource: string): string {
	const f = modelFiles(entry);
	return [
		`Animate: ${entry.title}`,
		'',
		entry.description,
		'',
		`Folder: ${entry.dir}`,
		`Height: ${entry.height_m} m.`,
		`Pivots: ${entry.parts.join(', ')}.`,
		'',
		'Clips:',
		...entry.clips.map(
			(c) => `- ${c.name}: ${c.seconds} s, ${c.loop ? 'loops' : 'plays once'}. ${c.action}`
		),
		'',
		`Write ${f.anim}. Check each clip with check_3d (path ${f.build}, anim ${f.anim},`,
		`out ${f.glb}, clip <name>). Do not edit ${entry.id}.js.`,
		'',
		`${f.build}:`,
		'```js',
		buildSource,
		'```'
	].join('\n');
}

/** The next animation round's message: what the last check found. */
export function animateRepairPrompt(entry: ModelEntry, problems: string[]): string {
	const f = modelFiles(entry);
	return [
		`The clips for ${entry.title} (${f.anim}) are not done yet. The last check found:`,
		'',
		...problems.map((p) => `- ${p}`),
		'',
		'Clips: ' +
			entry.clips
				.map((c) => `${c.name} (${c.seconds} s, ${c.loop ? 'loops' : 'once'})`)
				.join(', ') +
			'.',
		'',
		`Read ${f.anim} and ${f.build}. Fix ${entry.id}.anim.js only, and check each clip`,
		`again (path ${f.build}, anim ${f.anim}, out ${f.glb}, clip <name>).`
	].join('\n');
}
