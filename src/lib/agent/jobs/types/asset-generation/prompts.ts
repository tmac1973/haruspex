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
		'   - `kind`: `sprite` for an object or character that needs a transparent',
		'     background, `texture` for ground or walls that must tile seamlessly,',
		'     `icon` for a small UI symbol.',
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
