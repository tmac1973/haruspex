/** Asset-generation prompts. */

import type { AssetKind } from '$lib/assets/spec/types';

/**
 * The spec-derivation turn.
 *
 * It reads the project before it lists anything. A game with a content tree
 * already on disk knows exactly which sprites it needs, and a list invented
 * from the description alone will name things the code never asks for while
 * missing things it does.
 */
/**
 * What a texture is, said the same way by both prompts that write a spec.
 *
 * Run 108 asked for "subway entrance", "camp" and "building" as textures and
 * got a staircase seen from the front, tents round a fire and a façade: each
 * is an object, and an object cannot tile. Indented to sit under a `kind`
 * bullet.
 */
export const KIND_RULE: string[] = [
	'   - `kind`: `texture` ONLY for a surface seen from directly above that',
	'     fills the tile edge to edge: ground, floor, road, grass, water, roof,',
	'     the top of a wall. Anything with an outline is a `sprite`, drawn over a',
	'     floor texture: an entrance, exit, door, stairs, hatch, camp, tent,',
	'     furniture, vehicle, sign, crate or building seen as a whole. `icon` for',
	'     a small UI symbol.',
	'     Good textures: "cracked grey asphalt", "short green grass", "white',
	'     subway wall tiles". Not textures: "subway entrance" (a sprite over a',
	'     floor), "survivor camp" (tent and fire sprites over dirt), "building"',
	'     (a roof texture, or a building sprite).'
];

export function specDerivationPrompt(description: string, specPath: string): string {
	return [
		'You are listing the images a project needs, so they can be generated.',
		'',
		`What the user asked for: ${description}`,
		'',
		'Process:',
		'1. Look at the working directory first. If there is content on disk —',
		'   data files, a content tree, source that names sprites or tiles — read it,',
		'   and let it decide the list. A list invented from the description alone',
		'   names things the code never asks for and misses things it does.',
		'2. Decide ONE shared style, and keep it SHORT — one line, at most about',
		'   25 words. It is prepended to the style anchor and appended to every',
		'   asset prompt, and the image model reads only the first 77 tokens of',
		'   anything it is given: a long style pushes the actual subject out of',
		'   that window and the model renders the style with nothing in it.',
		'   Describe the medium, the line weight and how saturated the colours are.',
		'   Do NOT name colours or a colour scheme: the style is added to every',
		'   prompt, and "rust and concrete" turns the grass brown. Each entry\'s own',
		'   colours belong in its prompt. Do NOT describe the subject, the camera',
		'   angle, the genre or the lighting either.',
		'   Good: "16-bit pixel art, flat shading, bold dark outline, muted colours".',
		'   Too long: anything with semicolons, or a list of six clauses.',
		'3. List every image the project needs, and nothing it does not. Each entry:',
		...KIND_RULE,
		'   - `prompt`: the SUBJECT only, with its own colours ("green weeds",',
		'     "rusty red barrel"). The shared style is added automatically, so',
		'     repeating it here just dilutes both. For a texture, name the surface,',
		'     not "seamless" or "tiling" — those words draw a grid of tiles.',
		'   - `sheet` (sprites and icons): a short group name. Entries with the same',
		'     name are drawn together, up to nine at a time, at ONE scale and from ONE',
		'     view — so group things that belong side by side: items with items,',
		'     characters with characters, vehicles with vehicles. A coin beside a',
		'     building comes out as a giant coin or a toy building.',
		'   - `anchorSheet`: name ONE of your sheets whose subjects together show the',
		'     look of the whole set — a spread, not four of one thing. It is generated',
		'     first, for you to approve before the rest.',
		'4. Call `submit_asset_spec` exactly once with the result.',
		'',
		'You do not choose ids or file paths — those are assigned from your titles,',
		'so that the names the project references cannot drift.',
		`The result is written to ${specPath}; you do not write it yourself.`,
		'',
		'Nobody is available to answer questions. There is no tool to ask with.',
		'Decide from the project and the description, and submit.'
	].join('\n');
}

/** Sent back when a derived spec failed validation, so the retry is pointed. */
export function specRetryPrompt(problems: string[]): string {
	return [
		'That spec has problems:',
		'',
		...problems.map((p) => `- ${p}`),
		'',
		'Call `submit_asset_spec` again with the whole list corrected. Do not explain;',
		'submit.'
	].join('\n');
}

/**
 * The vision judge.
 *
 * Deliberately narrow. It is asked two things a mechanical check cannot
 * answer — is this the right subject, and does it look like the rest of the
 * set — and explicitly told not to grade craft, because a model asked for an
 * opinion on quality will reject perfectly good 32-pixel art for being 32
 * pixels.
 */
export function judgePrompt(
	subject: string,
	stylePrompt: string,
	kind?: AssetKind,
	hint?: string
): string {
	const texture = kind === 'texture';
	return [
		'The first image is the style reference for a set of game assets.',
		'The second is one generated asset from that set.',
		'',
		`The asset is supposed to be: ${subject}`,
		`The shared style is: ${stylePrompt}`,
		...(hint ? ['', hint] : []),
		'',
		texture
			? 'Answer three questions, and only these three:'
			: 'Answer two questions, and only these two:',
		'1. Is the subject recognisably what it was supposed to be?',
		'2. Does it belong to the same set as the reference — same medium, same',
		'   level of detail? Its colours may differ: every subject has its own.',
		...(texture
			? [
					'3. Is it a flat surface that fills the frame, seen from above or straight',
					'   on? Reject a scene with perspective or a horizon, a border, or a grid',
					'   of separate tiles.'
				]
			: []),
		'',
		'Do NOT judge craft, resolution or polish. These are small pixel-art',
		'images and they are meant to look like it. Reject only if the subject is',
		texture
			? 'wrong or absent, the style plainly does not match, or the view is wrong.'
			: 'wrong or absent, or the style plainly does not match.',
		'',
		`Call ${'submit_asset_judgement'} exactly once with your answer.`
	].join('\n');
}

/** Three recipes from the phase 17 prototype, as the recipe stage's examples. */
const RECIPE_EXAMPLES = [
	[
		'cracked asphalt with a worn yellow centre line',
		{
			base: { ramp: ['#2a2a2d', '#34343a', '#3e3e44'], cells: 4 },
			layers: [
				{ type: 'speckle', color: '#4c4c52', amount: 0.05 },
				{ type: 'cracks', color: '#1d1d20', cells: 3, coverage: 0.55 },
				{
					type: 'stripes',
					axis: 'x',
					pos: 15,
					width: 2,
					dash: [8, 8],
					color: '#b89a2e',
					wear: 0.25
				}
			]
		}
	],
	[
		'white subway wall tiles, grimy',
		{
			base: { ramp: ['#c9c4b4', '#d6d1c1'], cells: 4 },
			layers: [
				{
					type: 'bricks',
					w: 8,
					h: 4,
					gap: 1,
					offset: true,
					colors: ['#c2bcaa', '#d1ccbc', '#b8b2a0'],
					mortar: '#6e6a60'
				},
				{ type: 'blotches', color: '#8a8270', cells: 4, threshold: 0.85 }
			]
		}
	],
	[
		'dark river water',
		{
			base: { ramp: ['#1d3446', '#24405a', '#2c4c68'], cells: 2 },
			layers: [{ type: 'waves', color: '#4f7690', freq: 5, threshold: 0.9 }]
		}
	]
] as const;

/** `#rrggbb` for a packed `0xRRGGBBAA`. */
export function hexOf(packed: number): string {
	return `#${((packed >>> 8) & 0xffffff).toString(16).padStart(6, '0')}`;
}

/**
 * The recipe stage: one recipe per texture, from a fixed vocabulary of layers
 * that all wrap at the tile edge (`src-tauri/src/image_gen/texture/`).
 *
 * The palette is offered, not imposed. It comes from the anchor, which is a
 * sheet of sprites: a set of monsters has no water blue or grass green, and a
 * river forced into their colours is brown.
 */
export function recipePrompt(
	textures: Array<{ id: string; prompt: string }>,
	palette: number[],
	stylePrompt: string,
	feedback?: Map<string, string>
): string {
	return [
		'You are designing tileable ground and wall textures for a top-down 2D game.',
		'Each texture is drawn by code from a recipe you write: a base material,',
		'then layers over it. Every layer wraps at the tile edge, so the tile always',
		'tiles; your job is to make it read as the right material from above.',
		'',
		`The set's style: ${stylePrompt}`,
		...(palette.length
			? [
					`The set's colours, from its sprites: ${palette.map(hexOf).join(' ')}.`,
					'Prefer these. Use another colour only where the material needs one the',
					'list lacks (water, grass), and keep it as muted as these are.'
				]
			: []),
		'',
		'A recipe is JSON: { "base": {...}, "layers": [...], "wall_face": {...} }.',
		'Sizes and positions are in pixels of a 32-pixel tile.',
		'- base: { ramp: 2–8 colours "#rrggbb", darkest first, close in value;',
		'  cells: 1–16, noise cells across the tile (2 broad, 8 fine), default 4;',
		'  octaves: 1–4, default 3; dither: true/false, default true }',
		'Layers, in drawing order, at most 8:',
		'- { type: "speckle", color, amount: 0–0.5 } — scattered single pixels: grit.',
		'- { type: "cracks", color, cells: 1–12, coverage: 0–1, width?: 0.2–4 } —',
		'  thin cracks along irregular cells; higher coverage, fewer cracks.',
		'- { type: "blotches", color, cells: 4–16, threshold: 0–1 } — stains, moss,',
		'  puddles; higher threshold, fewer and smaller.',
		'- { type: "bricks", w, h, gap: 0–4, offset: true/false, colors: 1–6, mortar }',
		'  — bricks, blocks or tiles in rows; offset staggers alternate rows.',
		'- { type: "stripes", axis: "x" or "y", pos, width, dash?: [on, off], color,',
		'  wear?: 0–0.9 } — a painted line: "x" runs left to right at row pos.',
		'- { type: "waves", color, freq: 1–16, threshold: -1–1 } — water ripples.',
		'- { type: "grid", step, width?: 1–4, color } — seams: floor tiles, panels.',
		'- { type: "bevel", step: 4–32, light, dark } — raised plates or tiles.',
		'- wall_face: { height: 1–16, shade: 0–1 } — ONLY for a wall drawn with a',
		'  front face; darkens a band at the bottom. Omit it for anything flat.',
		'',
		'Keep each recipe simple: a base and one to three layers reads best at 32',
		'pixels. Do not draw objects: no doors, signs, furniture or vehicles.',
		'',
		'Examples:',
		...RECIPE_EXAMPLES.map(([what, r]) => `- ${what}: ${JSON.stringify(r)}`),
		'',
		'The textures:',
		...textures.map((t) => {
			const fix = feedback?.get(t.id);
			return `- ${t.id}: ${t.prompt}${fix ? `\n  Your last recipe for this needs changing: ${fix}` : ''}`;
		}),
		'',
		'Call `submit_texture_recipes` once, with a recipe for every id above.'
	].join('\n');
}
