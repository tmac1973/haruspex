/**
 * `make_asset`: the Shell assistant in code mode makes art for the project
 * it is working on — "a 32 px coin sprite in assets/" — and gets back a file
 * made the way the asset job makes one: transparent, cropped, sized,
 * palette-reduced and checked (`assets/single.ts`).
 *
 * A texture is drawn by code from a recipe the model writes, as the job draws
 * one (`assets/texture.ts`): it tiles by construction, takes a second, and
 * needs no image backend. Everything else needs one.
 *
 * Code mode only. Chat has `generate_image` for pictures; this is for a
 * project's files.
 */
import { errMessage } from '#lib/utils/error.ts';
import { registerTool } from '#lib/agent/tools/registry.ts';
import { toolError, toolResult, type ToolContext } from '#lib/agent/tools/types.ts';
import { ctxCwd, resolveShellPath } from '#lib/agent/tools/_helpers.ts';
import { assetIo, paletteFor, writeAsset, type Target } from '#lib/agent/tools/_assetIo.ts';
import { checkGround, MAX_SPRITES, spritesArg } from '#lib/agent/tools/_assetGround.ts';
import {
	makeTransition,
	parseTransition,
	type TransitionInput
} from '#lib/agent/tools/_assetTransition.ts';
import { localWriteBlocked } from '#lib/agent/tools/nested-session.ts';
import { MAX_PENDING_IMAGES } from '#lib/agent/tools/fs-read.ts';
import {
	DEFAULT_SIZE,
	makeSingleAsset,
	type SingleAssetInput,
	type SingleKind
} from '#lib/assets/single.ts';
import {
	MAX_VARIANTS,
	renderTexture,
	seedOf,
	textureFiles,
	tiledPreview,
	validateRecipe
} from '#lib/assets/texture.ts';
import { recipeGuide } from '#lib/agent/jobs/types/asset-generation/prompts.ts';
import type { TextureRecipe } from '#lib/ipc/gen/TextureRecipe.ts';
import { ImageBackendError } from '#lib/image/types.ts';
import { getSettings } from '#lib/stores/settings.ts';
import { pngDataUrl as dataUrl } from '#lib/utils/base64.ts';

/** What make_asset makes: the image backend's kinds, and what code draws. */
type Kind = SingleKind | 'texture' | 'transition';

const KINDS: Kind[] = ['sprite', 'icon', 'texture', 'transition', 'image'];

/** A texture's edge when none is asked for: the tile its recipe is written for. */
const TEXTURE_SIZE = 32;

/** A sprite, icon or picture as the image backend draws it. */
type PaintInput = Omit<SingleAssetInput, 'palette'>;

interface ParsedInput {
	asset: Omit<PaintInput, 'kind'> & { kind: Kind };
	path: string;
	paletteFrom: string | null;
	/** Texture only: sprites that will stand on it, to measure it against. */
	sprites: string[];
	/** A texture's recipe, unchecked; Rust's check comes next. */
	recipe: Record<string, unknown> | null;
	/** Every file a texture writes: the path, then its variants. */
	files: string[];
	/** A transition's arguments. */
	transition: TransitionInput | null;
}

/** The call's arguments, or what is wrong with them. */
function parseInput(args: Record<string, unknown>): ParsedInput | string {
	const kind = KINDS.find((k) => k === args.kind);
	if (!kind) return `kind must be one of ${KINDS.join(', ')}.`;
	const prompt = typeof args.prompt === 'string' ? args.prompt.trim() : '';
	const path = typeof args.path === 'string' ? args.path.trim() : '';
	if (!prompt || !path) return 'make_asset needs "prompt" and "path".';
	const size = typeof args.size === 'number' && args.size > 0 ? Math.round(args.size) : undefined;
	const style = typeof args.style === 'string' ? args.style : undefined;
	const from = typeof args.palette_from === 'string' ? args.palette_from.trim() : '';
	const drawn = codeArgs(kind, args, path);
	if (typeof drawn === 'string') return drawn;
	const sprites = spritesArg(args.sprites);
	if (typeof sprites === 'string') return sprites;
	// A tiling picture is the image backend's; a pixel-art tile is a texture.
	const seamless = kind === 'image' && args.seamless === true;
	return {
		asset: { kind, prompt, size, style, ...(seamless ? { seamless } : {}) },
		path,
		paletteFrom: from || null,
		sprites,
		...drawn
	};
}

/** What code draws from: a texture's recipe and files, or a transition's arguments. */
function codeArgs(
	kind: Kind,
	args: Record<string, unknown>,
	path: string
): Pick<ParsedInput, 'recipe' | 'files' | 'transition'> | string {
	const transition = kind === 'transition' ? parseTransition(args) : null;
	if (typeof transition === 'string') return transition;
	const recipe = recipeArg(args.recipe);
	if (kind === 'texture' && !recipe) {
		return 'A texture is drawn from a recipe: pass "recipe" as described in its parameter.';
	}
	return { recipe, files: textureFiles(path, args.variants), transition };
}

/** A texture's recipe as given, unchecked, or null when it is not an object. */
function recipeArg(r: unknown): ParsedInput['recipe'] {
	return r && typeof r === 'object' && !Array.isArray(r) ? (r as ParsedInput['recipe']) : null;
}

/** A sprite, icon or picture, drawn by the image backend. */
async function paintAsset(asset: PaintInput, input: ParsedInput, target: Target, ctx: ToolContext) {
	const { path, overwrite, io } = target;
	if (getSettings().imageBackendKind === 'none') {
		return toolResult(
			toolError(
				`A ${asset.kind} needs image generation: set one up in Settings → Image. ` +
					'Only kind texture works without it, and a texture is a surface that fills ' +
					'the tile: it cannot draw an object.'
			)
		);
	}

	// Refuse a path it could not write before spending a minute drawing.
	const unwritable = await writeAsset(path, new Uint8Array(), overwrite, true, io);
	if (unwritable) return toolResult(toolError(unwritable));

	const palette = await paletteFor(input.paletteFrom, target);
	if (typeof palette === 'string') return toolResult(palette);

	const started = Date.now();
	const tick = setInterval(
		() => ctx.onProgress?.(`Drawing… ${Math.round((Date.now() - started) / 1000)} s`),
		1000
	);
	let made;
	try {
		ctx.onProgress?.('Drawing…');
		made = await makeSingleAsset({ ...asset, palette }, { signal: ctx.signal });
	} catch (e) {
		if (e instanceof ImageBackendError && e.kind === 'cancelled') throw e;
		return toolResult(toolError(`Could not make it: ${errMessage(e)}`));
	} finally {
		clearInterval(tick);
	}

	const failed = await writeAsset(path, made.bytes, overwrite, false, io);
	if (failed) return toolResult(toolError(failed));

	const url = dataUrl(made.bytes);
	// So the assistant can look at what it made, and redo it if it's wrong.
	if (ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES) {
		ctx.pendingImages.push({ path, dataUrl: url });
	}
	return toolResult(
		[
			`Wrote ${path} (${made.width}×${made.height}, ${made.model}, seed ${made.seed}).`,
			made.checks.passed
				? 'It passed its checks.'
				: `It failed these checks: ${made.checks.failed.join(', ')} — look at it and decide whether to redo it.`,
			...made.notes
		].join(' '),
		url
	);
}

/**
 * A texture drawn by code from the model's recipe: every variant written,
 * and the base shown back laid 3×3, so the model sees what repeats.
 */
async function makeTexture(input: ParsedInput, target: Target, ctx: ToolContext) {
	const { path, overwrite, io } = target;
	const refused = await validateRecipe(input.recipe);
	if (refused) return toolResult(toolError(`The recipe was refused: ${refused}`));

	const paths = input.files.map((f) => resolveShellPath(f, target.cwd));
	for (const p of paths) {
		const unwritable = await writeAsset(p, new Uint8Array(), overwrite, true, io);
		if (unwritable) return toolResult(toolError(unwritable));
	}
	const palette = await paletteFor(input.paletteFrom, target);
	if (typeof palette === 'string') return toolResult(palette);

	const size = input.asset.size ?? TEXTURE_SIZE;
	let tiles: Uint8Array[];
	try {
		// Seeded from the path, so a revised recipe moves only what it changed.
		const recipe = input.recipe as unknown as TextureRecipe;
		tiles = await renderTexture(recipe, size, seedOf(path), paths.length, palette ?? []);
	} catch (e) {
		return toolResult(toolError(`Could not draw it: ${errMessage(e)}`));
	}
	for (const [k, bytes] of tiles.entries()) {
		const failed = await writeAsset(paths[k], bytes, overwrite, false, io);
		if (failed) return toolResult(toolError(failed));
	}

	const ground = input.sprites.length
		? await checkGround(tiles[0], size, input.sprites, target)
		: null;
	if (typeof ground === 'string') return toolResult(toolError(ground));
	const url = dataUrl(ground ? ground.preview : await tiledPreview(tiles[0], size));
	const sees = ctx.visionSupported !== false && ctx.pendingImages.length < MAX_PENDING_IMAGES;
	if (sees) ctx.pendingImages.push({ path, dataUrl: url });
	return toolResult(
		[
			`Wrote ${paths.join(', ')} (${size}×${size}, drawn from the recipe).`,
			...(sees
				? [
						'The image shows the first laid 3×3, as a map lays it' +
							(ground ? ', with the sprites on the diagonal' : '') +
							'. If a line or a spot sits in the same place in every copy, take it out of ' +
							'the recipe and draw again with overwrite: true.'
					]
				: []),
			...(ground ? [ground.note] : [])
		].join(' '),
		url
	);
}

registerTool({
	category: 'image',
	schema: {
		type: 'function',
		function: {
			name: 'make_asset',
			description:
				'Make an image file for the project: a sprite, icon or tiling texture made the way a game ' +
				'asset should be (transparent background, cropped, sized, reduced to a palette), or a ' +
				'plain picture; or a transition set, the 16 edge tiles where two of your textures meet. ' +
				'Textures and transitions are drawn by code from your recipes in a second; the rest use ' +
				'the image generation in Settings → Image and take 30 s to a few minutes. Pass ' +
				'palette_from with an existing asset to keep a set consistent.',
			parameters: {
				type: 'object',
				properties: {
					kind: { type: 'string', enum: KINDS, description: 'What to make.' },
					prompt: {
						type: 'string',
						description: 'The subject, in a short phrase: "a gold coin", "mossy cobblestones".'
					},
					path: {
						type: 'string',
						description:
							'Where to write the PNG, relative to the current directory or absolute. Its folder must exist.'
					},
					size: {
						type: 'number',
						description: `Target edge in px (sprite ${DEFAULT_SIZE.sprite}, icon ${DEFAULT_SIZE.icon}, texture ${TEXTURE_SIZE} by default; a texture's is a multiple of 4 from 8 to 256). Use the size the project uses.`
					},
					recipe: {
						type: 'object',
						description:
							'Texture or transition, and required for one: how code draws it (for a transition, ' +
							'the first material or the solid). ' +
							recipeGuide().join('\n')
					},
					view: {
						type: 'string',
						enum: ['top', 'side'],
						description:
							'Transition only: top for two ground textures meeting, side for platform ground against air.'
					},
					recipe_b: {
						type: 'object',
						description:
							"Transition, top only: the second material's recipe, as you wrote it for its texture."
					},
					cap: {
						type: 'object',
						description:
							'Transition, side only: a recipe drawn along upward faces (grass on dirt). Optional.'
					},
					edge: {
						type: 'object',
						description:
							'Transition only: { wobble?: 0–0.25, how far the border wanders; rim?: "#rrggbb", a line along it; cap_height?: 1–8, side only }.'
					},
					seed_from: {
						type: 'string',
						description:
							"Transition only: the texture file you drew recipe into, so the set's plain tiles match it exactly."
					},
					seed_from_b: {
						type: 'string',
						description: 'Transition, top only: the texture file you drew recipe_b into.'
					},
					variants: {
						type: 'number',
						description: `Texture only: tiles to write, 1–${MAX_VARIANTS}, default 1. The same material with its details moved, to mix on a map; the second is <name>_1.png.`
					},
					style: {
						type: 'string',
						description: 'One line of style, e.g. "16-bit pixel art, dark outlines".'
					},
					seamless: {
						type: 'boolean',
						description:
							'Image only: make the picture tile edge to edge, for a painted material. A pixel-art tile is kind texture.'
					},
					palette_from: {
						type: 'string',
						description:
							"An existing image whose colours to draw in, to match a set's palette. For a " +
							"texture, another texture, never a sprite: ground in the sprites' colours hides them."
					},
					sprites: {
						type: 'array',
						items: { type: 'string' },
						description: `Texture only: up to ${MAX_SPRITES} sprite files that will stand on it. The result says whether they would be hard to see on it, and the preview shows them on the tile.`
					},
					overwrite: { type: 'boolean', description: 'Replace an existing file. Default false.' }
				},
				required: ['kind', 'prompt', 'path']
			}
		}
	},
	displayLabel: (args) => `make ${String(args.kind ?? 'asset')}: ${String(args.path ?? '')}`,
	execute: async (args, ctx) => {
		const input = parseInput(args);
		if (typeof input === 'string') return toolResult(toolError(input));

		// The terminal may have walked off this machine (ssh, a container): the
		// file would land here while the model thinks it is over there.
		const elsewhere = await localWriteBlocked('make_asset', ctx);
		if (elsewhere) return toolResult(toolError(elsewhere));
		// Relative to the shell's folder, or in the Code tab the session's.
		const cwd = ctxCwd(ctx);
		const path = resolveShellPath(input.path, cwd);
		const target = { path, overwrite: args.overwrite === true, io: assetIo(ctx), cwd };
		const { kind, ...rest } = input.asset;
		if (kind === 'transition') {
			// parseInput refuses a transition without its arguments.
			const size = input.asset.size ?? TEXTURE_SIZE;
			return makeTransition(input.transition!, size, input.paletteFrom, target, ctx);
		}
		return kind === 'texture'
			? makeTexture(input, target, ctx)
			: paintAsset({ ...rest, kind }, input, target, ctx);
	}
});
